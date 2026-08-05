import cron from 'node-cron';
import { listAllMonitors, getMonitor } from './db.js';
import { checkMonitor } from './monitor.js';
import { notifyChange, notifyStatus } from './notify.js';

/** @type {Map<string, import('node-cron').ScheduledTask>} */
const jobs = new Map();
const running = new Set();
const queue = [];
let active = 0;
const MAX_CONCURRENT = 2;

async function executeCheck(id, reason = 'schedule') {
  if (running.has(id)) return;
  running.add(id);
  try {
    const monitor = getMonitor(id);
    if (!monitor || !monitor.enabled) return;

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

function cronExpression(intervalMinutes) {
  const minutes = Math.max(1, Number(intervalMinutes) || 5);
  if (minutes < 60) return `*/${minutes} * * * *`;
  const hours = Math.min(24, Math.floor(minutes / 60));
  return `0 */${hours} * * *`;
}

export function scheduleMonitor(monitor) {
  unscheduleMonitor(monitor.id);
  if (!monitor.enabled) return;

  const expr = cronExpression(monitor.intervalMinutes);
  if (!cron.validate(expr)) return;

  const task = cron.schedule(expr, () => {
    runCheck(monitor.id, 'schedule');
  });
  jobs.set(monitor.id, task);
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
  for (const monitor of listAllMonitors()) scheduleMonitor(monitor);
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
