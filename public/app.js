const $ = (sel) => document.querySelector(sel);

const els = {
  form: $('#monitor-form'),
  monitors: $('#monitors'),
  live: $('#live-pill'),
  btnNotify: $('#btn-notify'),
  btnInstall: $('#btn-install'),
  notifyStatus: $('#notify-status'),
  browserNotifications: $('#browserNotifications'),
  desktopNotifications: $('#desktopNotifications'),
  diffDialog: $('#diff-dialog'),
  diffTitle: $('#diff-title'),
  diffSummary: $('#diff-summary'),
  diffView: $('#diff-view'),
  diffClose: $('#diff-close'),
};

let deferredInstall = null;
let browserNotifyEnabled = true;
let cachedMonitors = [];
let cachedEvents = [];
const expandedIds = new Set();

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function statusLabel(status) {
  return (
    {
      ok: 'ok',
      changed: 'mudou',
      error: 'erro',
      pending: 'aguardando',
    }[status] || status || '—'
  );
}

function updateNotifyUi() {
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const map = {
    granted: 'concedida',
    denied: 'negada',
    default: 'ainda não pedida',
    unsupported: 'não suportada neste navegador',
  };
  els.notifyStatus.textContent = `Permissão do navegador: ${map[perm] || perm}`;
  els.btnNotify.textContent =
    perm === 'granted' ? 'Notificações ativas' : 'Ativar notificações';
}

async function enableBrowserNotifications() {
  if (!('Notification' in window)) {
    alert('Este navegador não suporta notificações.');
    return false;
  }
  const perm = await Notification.requestPermission();
  updateNotifyUi();
  return perm === 'granted';
}

function showBrowserNotification(payload) {
  if (!browserNotifyEnabled) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const n = new Notification(payload.title || 'MonitorWeb', {
    body: payload.body || 'Mudança detectada',
    icon: '/icon.svg',
    tag: payload.event?.id || payload.monitor?.id || 'monitorweb',
    data: { url: payload.url },
  });
  n.onclick = () => {
    window.focus();
    if (payload.url) window.open(payload.url, '_blank');
    n.close();
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", '&#39;');
}

function eventsForMonitor(monitorId) {
  return cachedEvents.filter((e) => e.monitorId === monitorId);
}

function renderEventItem(e) {
  return `
    <article class="event" data-event-id="${e.id}">
      <div class="event-main">
        <p class="event-time">${formatDate(e.createdAt)}</p>
        <p class="event-summary">${escapeHtml(e.summary || 'Alteração detectada')}</p>
      </div>
      <div class="actions">
        <button class="btn small" data-action="diff" type="button">Ver diff</button>
        <a class="btn small ghost" href="${escapeAttr(e.url)}" target="_blank" rel="noopener">Abrir página</a>
      </div>
    </article>`;
}

function renderMonitors(monitors) {
  cachedMonitors = monitors;
  if (!monitors.length) {
    els.monitors.innerHTML = `<p class="empty">Nenhum monitor ainda. Adicione a primeira URL ao lado.</p>`;
    return;
  }

  els.monitors.innerHTML = monitors
    .map((m) => {
      const open = expandedIds.has(m.id);
      const events = eventsForMonitor(m.id);
      return `
      <article class="card accordion ${open ? 'is-open' : ''}" data-id="${m.id}">
        <button type="button" class="accordion-trigger" data-action="toggle-expand" aria-expanded="${open}">
          <span class="chevron" aria-hidden="true"></span>
          <span class="accordion-title">
            <strong>${escapeHtml(m.name)}</strong>
            <span class="accordion-meta">${events.length} alteração${events.length === 1 ? '' : 'ões'}</span>
          </span>
          <span class="status ${escapeAttr(m.lastStatus || 'pending')}">${statusLabel(m.lastStatus)}</span>
        </button>

        <div class="accordion-summary">
          <p class="meta"><a href="${escapeAttr(m.url)}" target="_blank" rel="noopener">${escapeHtml(m.url)}</a></p>
          <p class="meta">A cada ${m.intervalMinutes} min${m.selector ? ` · seletor <code>${escapeHtml(m.selector)}</code>` : ''}${m.lastContentKind ? ` · fonte <code>${escapeHtml(m.lastContentKind)}</code>` : ''}</p>
          ${m.lastSourceUrl && m.lastSourceUrl !== m.url ? `<p class="meta">API: <a href="${escapeAttr(m.lastSourceUrl)}" target="_blank" rel="noopener">${escapeHtml(m.lastSourceUrl)}</a></p>` : ''}
          <p class="meta">Última checagem ${formatDate(m.lastCheckedAt)}</p>
          ${m.lastError ? `<p class="meta warn-text">Aviso: ${escapeHtml(m.lastError)}</p>` : ''}
          <div class="actions">
            <button class="btn small" data-action="check" type="button">Verificar agora</button>
            <button class="btn small" data-action="toggle" type="button">${m.enabled ? 'Pausar' : 'Ativar'}</button>
            <button class="btn small danger" data-action="delete" type="button">Excluir</button>
          </div>
        </div>

        <div class="accordion-panel" ${open ? '' : 'hidden'}>
          <h4 class="history-title">Alterações deste site</h4>
          ${
            events.length
              ? `<div class="events">${events.map(renderEventItem).join('')}</div>`
              : `<p class="empty">Nenhuma alteração registrada ainda para este site.</p>`
          }
        </div>
      </article>`;
    })
    .join('');
}

function originLabel(event) {
  const page = event.url || '';
  const source = event.sourceUrl || page;
  const fromApi = source && page && source !== page;
  if (fromApi) {
    return `
      <div class="change-origin">
        <p><span>Página monitorada</span> <a href="${escapeAttr(page)}" target="_blank" rel="noopener">${escapeHtml(page)}</a></p>
        <p><span>Origem dos dados</span> <a href="${escapeAttr(source)}" target="_blank" rel="noopener">${escapeHtml(source)}</a></p>
      </div>`;
  }
  return `
    <div class="change-origin">
      <p><span>Origem</span> <a href="${escapeAttr(source || page)}" target="_blank" rel="noopener">${escapeHtml(source || page || '—')}</a></p>
    </div>`;
}

function renderChangeItem(item) {
  if (item.to == null && item.from != null) {
    return `
      <div class="change-row">
        <span class="change-label">${escapeHtml(item.label)}</span>
        <span class="change-from only">${escapeHtml(item.from)}</span>
      </div>`;
  }
  if (item.from == null && item.to != null) {
    return `
      <div class="change-row">
        <span class="change-label">${escapeHtml(item.label)}</span>
        <span class="change-to only">${escapeHtml(item.to)}</span>
      </div>`;
  }
  return `
    <div class="change-row">
      <span class="change-label">${escapeHtml(item.label)}</span>
      <div class="change-values">
        <span class="change-from">${escapeHtml(item.from)}</span>
        <span class="change-arrow" aria-hidden="true">→</span>
        <span class="change-to">${escapeHtml(item.to)}</span>
      </div>
    </div>`;
}

function renderChangeGroup(group) {
  return `
    <article class="change-card">
      <h4>${escapeHtml(group.title)}</h4>
      <div class="change-rows">
        ${(group.items || []).map(renderChangeItem).join('')}
      </div>
    </article>`;
}

function openDiff(event) {
  const changes = Array.isArray(event.changes) ? event.changes : [];
  els.diffTitle.textContent = `${event.monitorName} · ${formatDate(event.createdAt)}`;
  els.diffSummary.textContent = event.summary || 'Alterações detectadas';

  if (!changes.length) {
    els.diffView.innerHTML = `
      ${originLabel(event)}
      <p class="empty">Não há detalhes legíveis para esta alteração.</p>`;
  } else {
    els.diffView.innerHTML = `
      ${originLabel(event)}
      <div class="change-list">
        ${changes.map(renderChangeGroup).join('')}
      </div>`;
  }

  els.diffDialog.showModal();
}

async function refresh() {
  const [monitors, events, settings] = await Promise.all([
    api('/monitors'),
    api('/events?limit=100'),
    api('/settings'),
  ]);
  cachedEvents = events;
  renderMonitors(monitors);
  els.browserNotifications.checked = settings.browserNotifications !== false;
  els.desktopNotifications.checked = settings.desktopNotifications !== false;
  browserNotifyEnabled = settings.browserNotifications !== false;
}

function connectSse() {
  const es = new EventSource('/api/events/stream');
  let statusTimer = null;
  es.addEventListener('ready', () => {
    els.live.textContent = 'ao vivo';
    els.live.classList.add('live');
  });
  es.addEventListener('change', (ev) => {
    const payload = JSON.parse(ev.data);
    showBrowserNotification(payload);
    if (payload.monitor?.id) expandedIds.add(payload.monitor.id);
    refresh().catch(console.error);
  });
  es.addEventListener('status', () => {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => refresh().catch(console.error), 2500);
  });
  es.onerror = () => {
    els.live.textContent = 'reconectando…';
    els.live.classList.remove('live');
  };
}

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name: $('#name').value.trim(),
    url: $('#url').value.trim(),
    intervalMinutes: Number($('#intervalMinutes').value) || 5,
    selector: $('#selector').value.trim(),
    enabled: $('#enabled').checked,
  };
  try {
    await api('/monitors', { method: 'POST', body: JSON.stringify(body) });
    els.form.reset();
    $('#intervalMinutes').value = '5';
    $('#enabled').checked = true;
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

els.monitors.addEventListener('click', async (e) => {
  const expandBtn = e.target.closest('[data-action="toggle-expand"]');
  if (expandBtn) {
    const card = expandBtn.closest('.card');
    const id = card?.dataset.id;
    if (!id) return;
    if (expandedIds.has(id)) expandedIds.delete(id);
    else expandedIds.add(id);
    renderMonitors(cachedMonitors);
    return;
  }

  const diffBtn = e.target.closest('button[data-action="diff"]');
  if (diffBtn) {
    const id = diffBtn.closest('.event')?.dataset.eventId;
    if (!id) return;
    try {
      const event = await api(`/events/${id}`);
      openDiff(event);
    } catch (err) {
      alert(err.message);
    }
    return;
  }

  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const card = btn.closest('.card');
  const id = card?.dataset.id;
  if (!id) return;
  const action = btn.dataset.action;

  try {
    if (action === 'check') {
      btn.disabled = true;
      await api(`/monitors/${id}/check`, { method: 'POST', body: '{}' });
    }
    if (action === 'toggle') {
      const m = cachedMonitors.find((x) => x.id === id);
      await api(`/monitors/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !m.enabled }),
      });
    }
    if (action === 'delete') {
      if (!confirm('Excluir este monitor e seu histórico?')) return;
      expandedIds.delete(id);
      await api(`/monitors/${id}`, { method: 'DELETE' });
    }
    await refresh();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

els.diffClose.addEventListener('click', () => els.diffDialog.close());
els.diffDialog.addEventListener('click', (e) => {
  if (e.target === els.diffDialog) els.diffDialog.close();
});

els.btnNotify.addEventListener('click', () => enableBrowserNotifications());

els.browserNotifications.addEventListener('change', async () => {
  browserNotifyEnabled = els.browserNotifications.checked;
  await api('/settings', {
    method: 'PATCH',
    body: JSON.stringify({ browserNotifications: browserNotifyEnabled }),
  });
  if (browserNotifyEnabled) await enableBrowserNotifications();
});

els.desktopNotifications.addEventListener('change', async () => {
  await api('/settings', {
    method: 'PATCH',
    body: JSON.stringify({ desktopNotifications: els.desktopNotifications.checked }),
  });
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  els.btnInstall.classList.remove('hidden');
});

els.btnInstall.addEventListener('click', async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  els.btnInstall.classList.add('hidden');
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

updateNotifyUi();
connectSse();
refresh().catch((err) => {
  els.monitors.innerHTML = `<p class="empty">Falha ao carregar: ${escapeHtml(err.message)}</p>`;
});
