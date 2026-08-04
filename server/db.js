import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'store.json');

const defaultStore = () => ({
  monitors: [],
  events: [],
  settings: {
    desktopNotifications: true,
    browserNotifications: true,
  },
});

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function read() {
  ensureDir();
  if (!fs.existsSync(DB_FILE)) {
    const fresh = defaultStore();
    write(fresh);
    return fresh;
  }
  try {
    return { ...defaultStore(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch {
    const fresh = defaultStore();
    write(fresh);
    return fresh;
  }
}

function write(store) {
  ensureDir();
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

export function getSettings() {
  return read().settings;
}

export function updateSettings(patch) {
  const store = read();
  store.settings = { ...store.settings, ...patch };
  write(store);
  return store.settings;
}

export function listMonitors() {
  return read().monitors.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getMonitor(id) {
  return read().monitors.find((m) => m.id === id) || null;
}

export function createMonitor({ name, url, intervalMinutes = 5, selector = '', enabled = true }) {
  const store = read();
  const now = new Date().toISOString();
  const monitor = {
    id: randomUUID(),
    name: name?.trim() || new URL(url).hostname,
    url: url.trim(),
    intervalMinutes: Math.max(1, Number(intervalMinutes) || 5),
    selector: (selector || '').trim(),
    enabled: Boolean(enabled),
    lastCheckedAt: null,
    lastChangedAt: null,
    lastHash: null,
    lastStatus: 'pending',
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  store.monitors.push(monitor);
  write(store);
  return monitor;
}

export function updateMonitor(id, patch) {
  const store = read();
  const idx = store.monitors.findIndex((m) => m.id === id);
  if (idx < 0) return null;
  const current = store.monitors[idx];
  store.monitors[idx] = {
    ...current,
    ...patch,
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  };
  write(store);
  return store.monitors[idx];
}

export function deleteMonitor(id) {
  const store = read();
  const before = store.monitors.length;
  store.monitors = store.monitors.filter((m) => m.id !== id);
  store.events = store.events.filter((e) => e.monitorId !== id);
  write(store);
  return before !== store.monitors.length;
}

export function saveCheckResult(
  id,
  { hash, content, status, error, changed, summary, diffText, changes, sourceUrl, contentKind }
) {
  const store = read();
  const idx = store.monitors.findIndex((m) => m.id === id);
  if (idx < 0) return null;

  const now = new Date().toISOString();
  const monitor = store.monitors[idx];
  store.monitors[idx] = {
    ...monitor,
    lastCheckedAt: now,
    lastStatus: status,
    lastError: error || null,
    lastHash: hash ?? monitor.lastHash,
    lastChangedAt: changed ? now : monitor.lastChangedAt,
    updatedAt: now,
  };

  if (changed) {
    store.events.unshift({
      id: randomUUID(),
      monitorId: id,
      monitorName: monitor.name,
      url: monitor.url,
      sourceUrl: sourceUrl || monitor.lastSourceUrl || monitor.url,
      contentKind: contentKind || monitor.lastContentKind || null,
      createdAt: now,
      summary: summary || 'Conteúdo alterado',
      diffText: diffText || '',
      changes: Array.isArray(changes) ? changes : [],
      contentPreview: (content || '').slice(0, 4000),
    });
    store.events = store.events.slice(0, 200);
  }

  write(store);
  return { monitor: store.monitors[idx], event: changed ? store.events[0] : null };
}

export function listEvents({ monitorId, limit = 50 } = {}) {
  let events = read().events;
  if (monitorId) events = events.filter((e) => e.monitorId === monitorId);
  return events.slice(0, limit);
}

export function getEvent(id) {
  return read().events.find((e) => e.id === id) || null;
}

export { DATA_DIR };
