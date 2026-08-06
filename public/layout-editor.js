const HANDLES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

let editing = false;
let savedBlocks = {};
let draftBlocks = {};
let dragState = null;
let apiFn = null;
let onFlash = null;

function $(sel, root = document) {
  return root.querySelector(sel);
}

function blocksMap() {
  return { ...savedBlocks, ...draftBlocks };
}

function applySize(el, size) {
  if (!el || !size) return;
  if (size.w != null) {
    el.style.width = `${size.w}px`;
    el.style.maxWidth = '100%';
    el.style.boxSizing = 'border-box';
  }
  if (size.h != null) {
    el.style.height = `${size.h}px`;
    el.style.minHeight = `${size.h}px`;
    el.style.maxHeight = 'none';
    el.style.overflow = 'auto';
    el.style.boxSizing = 'border-box';
  }
}

function clearSize(el) {
  if (!el) return;
  el.style.width = '';
  el.style.height = '';
  el.style.minHeight = '';
  el.style.maxHeight = '';
  el.style.maxWidth = '';
  el.style.overflow = '';
}

export function applyUiLayout(layout) {
  savedBlocks = layout?.blocks && typeof layout.blocks === 'object' ? { ...layout.blocks } : {};
  if (!editing) draftBlocks = {};
  document.querySelectorAll('[data-layout-id]').forEach((el) => {
    const id = el.dataset.layoutId;
    const size = blocksMap()[id];
    if (size) applySize(el, size);
    else if (!editing) clearSize(el);
  });
}

function collectCurrentSizes() {
  const out = { ...blocksMap() };
  document.querySelectorAll('[data-layout-id]').forEach((el) => {
    const id = el.dataset.layoutId;
    if (!id) return;
    const rect = el.getBoundingClientRect();
    const hasCustom =
      el.style.width || el.style.height || out[id]?.w != null || out[id]?.h != null;
    if (!hasCustom && !editing) return;
    out[id] = {
      ...(out[id] || {}),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };
  });
  return out;
}

function ensureHandles(el) {
  if (el.querySelector(':scope > .layout-handles')) return;
  const wrap = document.createElement('div');
  wrap.className = 'layout-handles';
  wrap.setAttribute('aria-hidden', 'true');
  for (const dir of HANDLES) {
    const h = document.createElement('span');
    h.className = `layout-handle layout-handle-${dir}`;
    h.dataset.dir = dir;
    wrap.appendChild(h);
  }
  el.appendChild(wrap);
}

function removeHandles() {
  document.querySelectorAll('.layout-handles').forEach((n) => n.remove());
}

function setEditChrome(on) {
  const bar = $('#layout-edit-bar');
  const btn = $('#btn-layout-edit');
  if (bar) bar.hidden = !on;
  if (btn) btn.textContent = on ? 'Sair do layout' : 'Editar layout';
  document.body.classList.toggle('layout-edit-mode', on);
}

function startEdit() {
  editing = true;
  draftBlocks = { ...savedBlocks };
  document.querySelectorAll('[data-layout-id]').forEach((el) => {
    ensureHandles(el);
    const size = blocksMap()[el.dataset.layoutId];
    if (size) applySize(el, size);
    else {
      const rect = el.getBoundingClientRect();
      applySize(el, { w: Math.round(rect.width), h: Math.round(rect.height) });
    }
  });
  setEditChrome(true);
}

async function stopEdit({ restoreSaved = true } = {}) {
  editing = false;
  draftBlocks = {};
  removeHandles();
  setEditChrome(false);
  if (restoreSaved) applyUiLayout({ blocks: savedBlocks });
}

async function saveLayout() {
  if (!apiFn) return;
  const blocks = collectCurrentSizes();
  const data = await apiFn('/admin/layout', {
    method: 'PUT',
    body: JSON.stringify({ blocks }),
  });
  savedBlocks = data.blocks || {};
  draftBlocks = {};
  applyUiLayout(data);
  await stopEdit({ restoreSaved: false });
  onFlash?.('Layout salvo. Este padrão vale para todos os usuários.');
}

async function resetLayout() {
  if (!apiFn) return;
  if (!confirm('Restaurar o tamanho padrão de todos os blocos para todos os usuários?')) return;
  const data = await apiFn('/admin/layout', { method: 'DELETE' });
  savedBlocks = {};
  draftBlocks = {};
  applyUiLayout(data);
  await stopEdit({ restoreSaved: false });
  onFlash?.('Layout restaurado ao padrão.');
}

function onPointerDown(e) {
  if (!editing) return;
  const handle = e.target.closest?.('.layout-handle');
  if (!handle) return;
  e.preventDefault();
  e.stopPropagation();
  const el = handle.closest('[data-layout-id]');
  if (!el) return;
  const rect = el.getBoundingClientRect();
  dragState = {
    el,
    id: el.dataset.layoutId,
    dir: handle.dataset.dir,
    startX: e.clientX,
    startY: e.clientY,
    startW: rect.width,
    startH: rect.height,
    startLeft: rect.left,
    startTop: rect.top,
  };
  el.classList.add('is-resizing');
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp, { once: true });
}

function onPointerMove(e) {
  if (!dragState) return;
  const { el, id, dir, startX, startY, startW, startH } = dragState;
  const dx = e.clientX - startX;
  const dy = e.clientY - startY;
  let w = startW;
  let h = startH;
  if (dir.includes('e')) w = startW + dx;
  if (dir.includes('w')) w = startW - dx;
  if (dir.includes('s')) h = startH + dy;
  if (dir.includes('n')) h = startH - dy;

  const parent = el.parentElement;
  const parentW = parent?.clientWidth || window.innerWidth;
  w = Math.max(180, Math.min(w, parentW));
  h = Math.max(100, h);

  draftBlocks[id] = { w: Math.round(w), h: Math.round(h) };
  // Shared ids: apply to all matching nodes
  document.querySelectorAll(`[data-layout-id="${id.replace(/"/g, '')}"]`).forEach((node) => {
    applySize(node, draftBlocks[id]);
  });
}

function onPointerUp() {
  if (dragState?.el) dragState.el.classList.remove('is-resizing');
  dragState = null;
  window.removeEventListener('pointermove', onPointerMove);
}

export function refreshLayoutTargets() {
  applyUiLayout({ blocks: blocksMap() });
  if (editing) {
    document.querySelectorAll('[data-layout-id]').forEach((el) => ensureHandles(el));
  }
}

export function initLayoutEditor({ api, flash, isAdmin }) {
  apiFn = api;
  onFlash = flash;
  const btn = $('#btn-layout-edit');
  if (btn) {
    btn.classList.toggle('hidden', !isAdmin);
    btn.addEventListener('click', () => {
      if (!isAdmin) return;
      if (editing) stopEdit({ restoreSaved: true });
      else startEdit();
    });
  }
  $('#layout-save')?.addEventListener('click', () => {
    saveLayout().catch((err) => onFlash?.(err.message || 'Falha ao salvar layout', true));
  });
  $('#layout-discard')?.addEventListener('click', () => stopEdit({ restoreSaved: true }));
  $('#layout-reset')?.addEventListener('click', () => {
    resetLayout().catch((err) => onFlash?.(err.message || 'Falha ao restaurar layout', true));
  });
  document.addEventListener('pointerdown', onPointerDown, true);

  return api('/layout')
    .then((layout) => applyUiLayout(layout))
    .catch(() => applyUiLayout({ blocks: {} }));
}
