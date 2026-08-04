import { Router } from 'express';
import {
  listMonitors,
  getMonitor,
  createMonitor,
  updateMonitor,
  deleteMonitor,
  listEvents,
  getEvent,
  getSettings,
  updateSettings,
} from './db.js';
import { scheduleMonitor, unscheduleMonitor, rescheduleAll } from './scheduler.js';
import { addSseClient, removeSseClient } from './notify.js';
import { changesFromDiffText } from './humanDiff.js';
import { checkMonitor } from './monitor.js';
import { notifyChange, notifyStatus } from './notify.js';
import { fetchResponse, decodeResponseBody, formatFetchError } from './fetchPage.js';
import { getUserQuota } from './auth.js';

const router = Router();

function isValidUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function publicMonitor(monitor) {
  if (!monitor) return null;
  const { lastContent, ...rest } = monitor;
  return rest;
}

function ownedMonitor(req, id) {
  const monitor = getMonitor(id);
  if (!monitor || monitor.userId !== req.user?.id) return null;
  return monitor;
}

router.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'monitorweb' });
});

router.get('/health/outbound', async (req, res) => {
  const target = String(req.query.url || 'https://sei.rj.gov.br/');
  try {
    const parsed = new URL(target);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ ok: false, error: 'URL inválida' });
    }
  } catch {
    return res.status(400).json({ ok: false, error: 'URL inválida' });
  }

  try {
    const started = Date.now();
    const response = await fetchResponse(target);
    const body = await decodeResponseBody(response);
    res.json({
      ok: response.ok,
      status: response.status,
      elapsedMs: Date.now() - started,
      contentType: response.headers.get('content-type'),
      bytes: body.length,
      preview: body.replace(/\s+/g, ' ').slice(0, 180),
      relayConfigured: Boolean(
        process.env.FETCH_RELAY_URL || process.env.PROXY_URL || process.env.PROXY_RELAY_URL
      ),
      fetchRelayUrl: process.env.FETCH_RELAY_URL || process.env.PROXY_URL || null,
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: formatFetchError(err, target),
      raw: err?.message || String(err),
      code: err?.cause?.code || err?.code || null,
      hint: /sei\.rj\.gov\.br/i.test(target)
        ? 'O SEI geralmente não responde a partir do Railway (EUA). Use PROXY_URL no Brasil ou rode localmente.'
        : null,
    });
  }
});

router.get('/settings', (req, res) => {
  res.json(getSettings(req.user.id));
});

router.patch('/settings', (req, res) => {
  const settings = updateSettings(req.user.id, req.body || {});
  res.json(settings);
});

router.get('/monitors', (req, res) => {
  res.json(listMonitors({ userId: req.user.id }).map(publicMonitor));
});

router.post('/monitors', (req, res) => {
  const { name, url, intervalMinutes, selector, enabled } = req.body || {};
  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'URL inválida. Use http:// ou https://' });
  }
  const quota = getUserQuota(req.user.id);
  if (!quota.active) {
    return res.status(403).json({ error: 'Conta desativada' });
  }
  if (quota.remaining <= 0) {
    return res.status(403).json({
      error: `Limite de sites atingido (${quota.used}/${quota.maxMonitors}). Peça ao administrador para aumentar.`,
    });
  }
  const monitor = createMonitor({
    userId: req.user.id,
    name,
    url,
    intervalMinutes,
    selector,
    enabled,
  });
  scheduleMonitor(monitor);
  res.status(201).json(publicMonitor(monitor));
});

router.get('/monitors/:id', (req, res) => {
  const monitor = ownedMonitor(req, req.params.id);
  if (!monitor) return res.status(404).json({ error: 'Monitor não encontrado' });
  res.json(publicMonitor(monitor));
});

router.patch('/monitors/:id', (req, res) => {
  const existing = ownedMonitor(req, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Monitor não encontrado' });

  const patch = { ...req.body };
  delete patch.id;
  delete patch.userId;
  delete patch.createdAt;
  delete patch.lastContent;
  if (patch.url && !isValidUrl(patch.url)) {
    return res.status(400).json({ error: 'URL inválida' });
  }
  if (patch.intervalMinutes != null) {
    patch.intervalMinutes = Math.max(1, Number(patch.intervalMinutes) || 5);
  }

  const monitor = updateMonitor(req.params.id, patch);
  scheduleMonitor(monitor);
  res.json(publicMonitor(monitor));
});

router.delete('/monitors/:id', (req, res) => {
  const existing = ownedMonitor(req, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Monitor não encontrado' });
  unscheduleMonitor(req.params.id);
  const ok = deleteMonitor(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Monitor não encontrado' });
  res.json({ ok: true });
});

router.post('/monitors/:id/check', async (req, res) => {
  const monitor = ownedMonitor(req, req.params.id);
  if (!monitor) return res.status(404).json({ error: 'Monitor não encontrado' });
  try {
    const result = await checkMonitor(req.params.id, {
      previousContent: monitor.lastContent || '',
    });
    if (result.changed && result.event) {
      notifyChange({ monitor: result.monitor, event: result.event });
    } else {
      const m = result.monitor || getMonitor(req.params.id);
      notifyStatus(`OK: ${monitor.name}`, {
        monitorId: monitor.id,
        userId: monitor.userId || null,
        status: m?.lastStatus,
        error: result.error || m?.lastError || null,
        monitor: m
          ? {
              id: m.id,
              lastStatus: m.lastStatus,
              lastCheckedAt: m.lastCheckedAt,
              lastChangedAt: m.lastChangedAt,
              lastError: m.lastError,
              lastContentKind: m.lastContentKind,
            }
          : null,
      });
    }
  } catch (err) {
    return res.status(500).json({ error: formatFetchError(err) });
  }
  res.json(publicMonitor(getMonitor(req.params.id)));
});

router.get('/events', (req, res) => {
  const monitorId = req.query.monitorId || undefined;
  const limit = Number(req.query.limit) || 50;
  if (monitorId) {
    const monitor = ownedMonitor(req, monitorId);
    if (!monitor) return res.status(404).json({ error: 'Monitor não encontrado' });
  }
  res.json(listEvents({ userId: req.user.id, monitorId, limit }));
});

router.get('/events/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const client = addSseClient(res, req.user.id);
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
      removeSseClient(client);
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeSseClient(client);
  });
});

router.get('/events/:id', (req, res) => {
  const event = getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Evento não encontrado' });
  const monitor = event.monitorId ? getMonitor(event.monitorId) : null;
  const ownerId = event.userId || monitor?.userId;
  if (ownerId && ownerId !== req.user.id) {
    return res.status(404).json({ error: 'Evento não encontrado' });
  }
  const changes =
    Array.isArray(event.changes) && event.changes.length
      ? event.changes
      : changesFromDiffText(event.diffText || '');
  res.json({ ...event, changes });
});

router.post('/scheduler/reload', (_req, res) => {
  rescheduleAll();
  res.json({ ok: true });
});

export default router;
