import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.js';

const LAYOUT_FILE = path.join(DATA_DIR, 'ui-layout.json');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function getUiLayout() {
  ensureDir();
  if (!fs.existsSync(LAYOUT_FILE)) {
    return { version: 1, updatedAt: null, blocks: {} };
  }
  try {
    const data = JSON.parse(fs.readFileSync(LAYOUT_FILE, 'utf8'));
    return {
      version: 1,
      updatedAt: data.updatedAt || null,
      blocks: data.blocks && typeof data.blocks === 'object' ? data.blocks : {},
    };
  } catch {
    return { version: 1, updatedAt: null, blocks: {} };
  }
}

function cleanCoord(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.max(min, Math.min(max, n)));
}

export function saveUiLayout(blocks) {
  ensureDir();
  const clean = {};
  for (const [id, value] of Object.entries(blocks || {})) {
    if (!id || typeof id !== 'string') continue;
    const key = id.trim().slice(0, 80);
    if (!key) continue;
    const next = {};
    const w = cleanCoord(value?.w, 160, 4000);
    const h = cleanCoord(value?.h, 80, 4000);
    const x = cleanCoord(value?.x, -2400, 2400);
    const y = cleanCoord(value?.y, -2400, 2400);
    if (w != null) next.w = w;
    if (h != null) next.h = h;
    if (x != null) next.x = x;
    if (y != null) next.y = y;
    if (Object.keys(next).length) clean[key] = next;
  }
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    blocks: clean,
  };
  fs.writeFileSync(LAYOUT_FILE, JSON.stringify(payload, null, 2));
  return payload;
}

export function resetUiLayout() {
  ensureDir();
  const payload = { version: 1, updatedAt: new Date().toISOString(), blocks: {} };
  fs.writeFileSync(LAYOUT_FILE, JSON.stringify(payload, null, 2));
  return payload;
}
