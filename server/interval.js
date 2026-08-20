/** Intervalo mínimo de checagem (segundos). */
export const MIN_INTERVAL_SECONDS = 30;
/** Padrão: 5 minutos. */
export const DEFAULT_INTERVAL_SECONDS = 300;
/** Máximo: 24 horas. */
export const MAX_INTERVAL_SECONDS = 24 * 60 * 60;

/**
 * Normaliza intervalo a partir de segundos e/ou minutos legados.
 * @param {{ intervalSeconds?: unknown, intervalMinutes?: unknown }} input
 */
export function normalizeIntervalSeconds(input = {}) {
  const rawSec = Number(input.intervalSeconds);
  if (Number.isFinite(rawSec) && rawSec > 0) {
    return clampIntervalSeconds(rawSec);
  }
  const rawMin = Number(input.intervalMinutes);
  if (Number.isFinite(rawMin) && rawMin > 0) {
    return clampIntervalSeconds(rawMin * 60);
  }
  return DEFAULT_INTERVAL_SECONDS;
}

export function clampIntervalSeconds(value) {
  const n = Math.floor(Number(value) || DEFAULT_INTERVAL_SECONDS);
  return Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, n));
}

/** Lê o intervalo efetivo de um monitor (compatível com dados antigos em minutos). */
export function getMonitorIntervalSeconds(monitor) {
  return normalizeIntervalSeconds(monitor || {});
}
