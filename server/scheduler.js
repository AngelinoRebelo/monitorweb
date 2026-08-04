import cron from 'node-cron';
import { listMonitors, getMonitor } from './db.js';
import { checkMonitor } from './monitor.js';
import { notifyChange, notifyStatus } from './notify.js';

/** @type {Map<string, import('node-cron').ScheduledTask>} */
const jobs = new Map();
const running = new Set();

async function runCheck(id, reason = 'schedule') {
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
  // first pass shortly after boot
  setTimeout(() => {
    for (const monitor of listMonitors()) {
      if (monitor.enabled) runCheck(monitor.id, 'startup');
    }
  }, 2500);
}

export { runCheck };
