import cron from 'node-cron';
import { listMonitors, getMonitor } from './db.js';
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

    notifyStatus(`Verificando: ${monitor.name}`, { monitorId: id, reason });
    const result = await checkMonitor(id, {
      previousContent: monitor.lastContent || '',
    });

    if (result.changed && result.event) {
      notifyChange({ monitor: result.monitor, event: result.event });
    } else {
      notifyStatus(`OK: ${monitor.name}`, {
        monitorId: id,
        status: result.monitor?.lastStatus,
        error: result.error || result.monitor?.lastError || null,
      });
    }
  } catch (err) {
    notifyStatus(`Erro ao verificar monitor`, {
      monitorId: id,
      error: err.message || String(err),
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

async function runCheck(id, reason = 'schedule') {
  if (running.has(id) || queue.some((item) => item.id === id)) return;
  queue.push({ id, reason });
  pumpQueue();
  // wait until this id leaves queue+running (best-effort for manual checks)
  const started = Date.now();
  while (Date.now() - started < 120000) {
    if (!running.has(id) && !queue.some((item) => item.id === id)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
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
  for (const monitor of listMonitors()) scheduleMonitor(monitor);
}

export function startScheduler() {
  rescheduleAll();
  // staggered first pass to avoid flooding targets like SEI
  setTimeout(async () => {
    const monitors = listMonitors().filter((m) => m.enabled);
    for (const [index, monitor] of monitors.entries()) {
      setTimeout(() => {
        runCheck(monitor.id, 'startup');
      }, index * 1500);
    }
  }, 2500);
}

export { runCheck };
