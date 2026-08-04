import { spawn } from 'node:child_process';
import { getSettings } from './db.js';

/** @type {Set<{ res: import('express').Response, userId: string|null }>} */
const sseClients = new Set();

export function addSseClient(res, userId = null) {
  const client = { res, userId };
  sseClients.add(client);
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  return client;
}

export function removeSseClient(clientOrRes) {
  if (clientOrRes && clientOrRes.res) {
    sseClients.delete(clientOrRes);
    return;
  }
  for (const client of sseClients) {
    if (client.res === clientOrRes) sseClients.delete(client);
  }
}

export function broadcast(event, data, { userId } = {}) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    if (userId && client.userId && client.userId !== userId) continue;
    try {
      client.res.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

function canUseDesktopNotify() {
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.DBUS_SESSION_BUS_ADDRESS);
}

export function notifyDesktop({ title, body, url, userId }) {
  const settings = getSettings(userId);
  if (!settings.desktopNotifications) return false;
  if (!canUseDesktopNotify()) return false;

  try {
    const args = [
      '--app-name=MonitorWeb',
      '--urgency=normal',
      '--expire-time=12000',
      title || 'MonitorWeb',
      body || 'Mudança detectada',
    ];
    const child = spawn('notify-send', args, { stdio: 'ignore', detached: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function notifyChange({ monitor, event }) {
  const title = `Mudança: ${monitor.name}`;
  const body = event?.summary || 'A página monitorada foi alterada';
  const payload = {
    type: 'change',
    monitor,
    event,
    title,
    body,
    url: monitor.url,
    at: new Date().toISOString(),
  };

  broadcast('change', payload, { userId: monitor.userId || null });
  notifyDesktop({ title, body, url: monitor.url, userId: monitor.userId || null });
  return payload;
}

export function notifyStatus(message, extra = {}) {
  const userId = extra.userId || null;
  broadcast('status', { message, ...extra, at: new Date().toISOString() }, { userId });
}
