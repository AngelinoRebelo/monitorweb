import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'store.json');

const defaultSettings = () => ({
  desktopNotifications: true,
  browserNotifications: true,
});

const defaultStore = () => ({
  monitors: [],
  events: [],
  settings: defaultSettings(),
  settingsByUser: {},
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

/** Assign orphan monitors/events (pre-multiuser) to the given owner. */
export function claimOrphanData(userId) {
  if (!userId) return { monitors: 0, events: 0 };
  const store = read();
  let monitors = 0;
  let events = 0;
  for (const m of store.monitors) {
    if (!m.userId) {
      m.userId = userId;
      monitors += 1;
    }
  }
  for (const e of store.events) {
    if (!e.userId) {
      const owner = store.monitors.find((m) => m.id === e.monitorId)?.userId || userId;
      e.userId = owner;
      events += 1;
    }
  }
  if (monitors || events) write(store);
  return { monitors, events };
}

export function getSettings(userId) {
  const store = read();
  if (userId && store.settingsByUser?.[userId]) {
    return { ...defaultSettings(), ...store.settingsByUser[userId] };
  }
  return { ...defaultSettings(), ...(store.settings || {}) };
}

export function updateSettings(userId, patch) {
  const store = read();
  if (!store.settingsByUser) store.settingsByUser = {};
  if (userId) {
    store.settingsByUser[userId] = {
      ...defaultSettings(),
      ...store.settingsByUser[userId],
      ...patch,
    };
    write(store);
    return store.settingsByUser[userId];
  }
  store.settings = { ...defaultSettings(), ...store.settings, ...patch };
  write(store);
  return store.settings;
}

export function listMonitors({ userId } = {}) {
  let monitors = read().monitors;
  if (userId) monitors = monitors.filter((m) => m.userId === userId);
  return monitors.sort((a, b) => {
    const fav = Number(Boolean(b.favorite)) - Number(Boolean(a.favorite));
    if (fav) return fav;
    const tb = Date.parse(b.lastChangedAt || '') || 0;
    const ta = Date.parse(a.lastChangedAt || '') || 0;
    if (tb !== ta) return tb - ta;
    const cb = Date.parse(b.lastCheckedAt || '') || 0;
    const ca = Date.parse(a.lastCheckedAt || '') || 0;
    if (cb !== ca) return cb - ca;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

export function countMonitorsByUser(userId) {
  if (!userId) return 0;
  return read().monitors.filter((m) => m.userId === userId).length;
}

export function deleteUserData(userId) {
  if (!userId) return { monitors: 0, events: 0 };
  const store = read();
  const monitorIds = new Set(store.monitors.filter((m) => m.userId === userId).map((m) => m.id));
  const beforeM = store.monitors.length;
  const beforeE = store.events.length;
  store.monitors = store.monitors.filter((m) => m.userId !== userId);
  store.events = store.events.filter((e) => e.userId !== userId && !monitorIds.has(e.monitorId));
  if (store.settingsByUser?.[userId]) delete store.settingsByUser[userId];
  write(store);
  return { monitors: beforeM - store.monitors.length, events: beforeE - store.events.length };
}

export function listAllMonitors() {
  return read().monitors.slice();
}

export function getMonitor(id) {
  return read().monitors.find((m) => m.id === id) || null;
}

export function createMonitor({
  userId,
  name,
  url,
  intervalMinutes = 5,
  selector = '',
  enabled = true,
}) {
  if (!userId) throw new Error('userId é obrigatório');
  const store = read();
  const now = new Date().toISOString();
  const monitor = {
    id: randomUUID(),
    userId,
    name: name?.trim() || new URL(url).hostname,
    url: url.trim(),
    intervalMinutes: Math.max(1, Number(intervalMinutes) || 5),
    selector: (selector || '').trim(),
    enabled: Boolean(enabled),
    favorite: false,
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
  const safe = { ...patch };
  delete safe.id;
  delete safe.userId;
  delete safe.createdAt;
  delete safe.lastContent;
  store.monitors[idx] = {
    ...current,
    ...safe,
    id: current.id,
    userId: current.userId,
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
  {
    hash,
    content,
    status,
    error,
    changed,
    summary,
    diffText,
    changes,
    sourceUrl,
    contentKind,
    updateHash = true,
    lastContent,
    pendingHash,
    pendingHashCount,
    pendingContent,
  }
) {
  const store = read();
  const idx = store.monitors.findIndex((m) => m.id === id);
  if (idx < 0) return null;

  const now = new Date().toISOString();
  const monitor = store.monitors[idx];
  const next = {
    ...monitor,
    lastCheckedAt: now,
    lastStatus: status,
    lastError: error || null,
    lastHash: updateHash && hash != null ? hash : monitor.lastHash,
    lastChangedAt: changed ? now : monitor.lastChangedAt,
    updatedAt: now,
  };

  if (lastContent !== undefined) next.lastContent = lastContent;
  if (contentKind != null) next.lastContentKind = contentKind;
  if (sourceUrl != null) next.lastSourceUrl = sourceUrl;
  if (pendingHash !== undefined) next.pendingHash = pendingHash;
  if (pendingHashCount !== undefined) next.pendingHashCount = pendingHashCount;
  if (pendingContent !== undefined) next.pendingContent = pendingContent;

  store.monitors[idx] = next;

  if (changed) {
    store.events.unshift({
      id: randomUUID(),
      userId: monitor.userId || null,
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
    store.events = store.events.slice(0, 500);
  }

  write(store);
  return { monitor: store.monitors[idx], event: changed ? store.events[0] : null };
}

export function listEvents({ userId, monitorId, limit = 50 } = {}) {
  let events = read().events;
  if (userId) {
    const mine = new Set(
      read()
        .monitors.filter((m) => m.userId === userId)
        .map((m) => m.id)
    );
    events = events.filter((e) => e.userId === userId || mine.has(e.monitorId));
  }
  if (monitorId) events = events.filter((e) => e.monitorId === monitorId);
  return events.slice(0, limit);
}

export function getEvent(id) {
  return read().events.find((e) => e.id === id) || null;
}

export { DATA_DIR };
