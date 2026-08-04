import { spawn } from 'node:child_process';
import { getSettings } from './db.js';

const sseClients = new Set();

export function addSseClient(res) {
  sseClients.add(res);
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
}

export function removeSseClient(res) {
  sseClients.delete(res);
}

export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

function canUseDesktopNotify() {
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.DBUS_SESSION_BUS_ADDRESS);
}

export function notifyDesktop({ title, body, url }) {
  const settings = getSettings();
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

  broadcast('change', payload);
  notifyDesktop({ title, body, url: monitor.url });
  return payload;
}

export function notifyStatus(message, extra = {}) {
  broadcast('status', { message, ...extra, at: new Date().toISOString() });
}
