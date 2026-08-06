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

export function saveUiLayout(blocks) {
  ensureDir();
  const clean = {};
  for (const [id, value] of Object.entries(blocks || {})) {
    if (!id || typeof id !== 'string') continue;
    const key = id.trim().slice(0, 80);
    if (!key) continue;
    const w = value?.w != null ? Number(value.w) : null;
    const h = value?.h != null ? Number(value.h) : null;
    const next = {};
    if (Number.isFinite(w) && w >= 160) next.w = Math.round(w);
    if (Number.isFinite(h) && h >= 80) next.h = Math.round(h);
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
