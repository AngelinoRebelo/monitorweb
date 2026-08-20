import cron from 'node-cron';
import { listAllMonitors, getMonitor } from './db.js';
import { checkMonitor } from './monitor.js';
import { notifyChange, notifyStatus } from './notify.js';
import { getMonitorIntervalSeconds } from './interval.js';

/** @type {Map<string, import('node-cron').ScheduledTask>} */
const jobs = new Map();
const running = new Set();
const queue = [];
let active = 0;
const MAX_CONCURRENT = 2;
/** Tique global: avalia quais monitores já venceram o intervalo. */
const TICK_CRON = '*/15 * * * * *';
let tickTask = null;

async function executeCheck(id, reason = 'schedule') {
  if (running.has(id)) return;
  running.add(id);
  try {
    const monitor = getMonitor(id);
    if (!monitor || !monitor.enabled) return;

    if (monitor.userId) {
      try {
        const { findUserByIdPublic } = await import('./auth.js');
        const { hasAppAccess } = await import('./billing.js');
        const owner = findUserByIdPublic(monitor.userId);
        if (!hasAppAccess(owner)) return;
      } catch {
        /* if auth unavailable, continue */
      }
    }

    notifyStatus(`Verificando: ${monitor.name}`, {
      monitorId: id,
      reason,
      userId: monitor.userId || null,
      monitor: {
        id: monitor.id,
        lastStatus: 'pending',
        lastCheckedAt: monitor.lastCheckedAt,
        lastChangedAt: monitor.lastChangedAt,
        lastError: monitor.lastError,
      },
    });
    const result = await checkMonitor(id, {
      previousContent: monitor.lastContent || '',
    });

    if (result.changed && result.event) {
      notifyChange({ monitor: result.monitor, event: result.event });
    } else {
      const m = result.monitor || getMonitor(id);
      notifyStatus(`OK: ${monitor.name}`, {
        monitorId: id,
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
    const monitor = getMonitor(id);
    notifyStatus(`Erro ao verificar monitor`, {
      monitorId: id,
      userId: monitor?.userId || null,
      error: err.message || String(err),
      monitor: monitor
        ? {
            id: monitor.id,
            lastStatus: 'error',
            lastCheckedAt: monitor.lastCheckedAt,
            lastChangedAt: monitor.lastChangedAt,
            lastError: err.message || String(err),
          }
        : null,
    });
  } finally {
    running.delete(id);
  }
}

function pumpQueue() {
  while (active < MAX_CONCURRENT && queue.length) {
    const next = queue.shift();
    active += 1;
    executeCheck(next.id, next.reason)
      .catch(() => {})
      .finally(() => {
        active -= 1;
        pumpQueue();
      });
  }
}

async function waitUntilIdle(id, timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!running.has(id) && !queue.some((item) => item.id === id)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function runCheck(id, reason = 'schedule') {
  if (running.has(id) || queue.some((item) => item.id === id)) {
    await waitUntilIdle(id);
    if (reason !== 'manual') return;
  }
  queue.push({ id, reason });
  pumpQueue();
  await waitUntilIdle(id);
}

function isDue(monitor, now = Date.now()) {
  if (!monitor?.enabled) return false;
  if (!monitor.lastCheckedAt) return true;
  const last = Date.parse(monitor.lastCheckedAt);
  if (!Number.isFinite(last)) return true;
  return now - last >= getMonitorIntervalSeconds(monitor) * 1000;
}

function enqueueDueMonitors() {
  const now = Date.now();
  for (const monitor of listAllMonitors()) {
    if (!isDue(monitor, now)) continue;
    if (running.has(monitor.id) || queue.some((item) => item.id === monitor.id)) continue;
    queue.push({ id: monitor.id, reason: 'schedule' });
  }
  pumpQueue();
}

function ensureTick() {
  if (tickTask) return;
  if (!cron.validate(TICK_CRON)) {
    console.error('[scheduler] expressão de tique inválida:', TICK_CRON);
    return;
  }
  tickTask = cron.schedule(TICK_CRON, () => {
    enqueueDueMonitors();
  });
}

export function scheduleMonitor(monitor) {
  // Agendamento é global (tique a cada 15s). Mantemos a API para o restante do código.
  unscheduleMonitor(monitor.id);
  if (!monitor.enabled) return;
  ensureTick();
}

export function unscheduleMonitor(id) {
  const task = jobs.get(id);
  if (task) {
    task.stop();
    jobs.delete(id);
  }
}

export function rescheduleAll() {
  for (const id of [...jobs.keys()]) unscheduleMonitor(id);
  ensureTick();
}

export function startScheduler() {
  rescheduleAll();
  // staggered first pass to avoid flooding targets like SEI
  setTimeout(async () => {
    const monitors = listAllMonitors().filter((m) => m.enabled);
    for (const [index, monitor] of monitors.entries()) {
      setTimeout(() => {
        runCheck(monitor.id, 'startup');
      }, index * 1500);
    }
  }, 2500);

  // Expiry warnings + post-paid grace trial (hourly).
  cron.schedule('20 * * * *', () => {
    import('./billing-lifecycle.js')
      .then((m) => m.runBillingLifecycle())
      .catch((err) => console.error('[billing-lifecycle]', err?.message || err));
  });
  // Run once shortly after boot.
  setTimeout(() => {
    import('./billing-lifecycle.js')
      .then((m) => m.runBillingLifecycle())
      .catch((err) => console.error('[billing-lifecycle]', err?.message || err));
  }, 12000);
}

export { runCheck };
