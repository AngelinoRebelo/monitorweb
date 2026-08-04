const $ = (sel) => document.querySelector(sel);

const els = {
  form: $('#monitor-form'),
  monitors: $('#monitors'),
  events: $('#events'),
  live: $('#live-pill'),
  btnNotify: $('#btn-notify'),
  btnInstall: $('#btn-install'),
  notifyStatus: $('#notify-status'),
  browserNotifications: $('#browserNotifications'),
  desktopNotifications: $('#desktopNotifications'),
  diffDialog: $('#diff-dialog'),
  diffTitle: $('#diff-title'),
  diffContent: $('#diff-content'),
};

let deferredInstall = null;
let browserNotifyEnabled = true;

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

function renderMonitors(monitors) {
  if (!monitors.length) {
    els.monitors.innerHTML = `<p class="empty">Nenhum monitor ainda. Adicione a primeira URL ao lado.</p>`;
    return;
  }

  els.monitors.innerHTML = monitors
    .map(
      (m) => `
      <article class="card" data-id="${m.id}">
        <h3>${escapeHtml(m.name)}</h3>
        <p class="meta"><a href="${escapeAttr(m.url)}" target="_blank" rel="noopener">${escapeHtml(m.url)}</a></p>
        <p class="meta">A cada ${m.intervalMinutes} min${m.selector ? ` · seletor <code>${escapeHtml(m.selector)}</code>` : ''}${m.lastContentKind ? ` · fonte <code>${escapeHtml(m.lastContentKind)}</code>` : ''}</p>
        ${m.lastSourceUrl && m.lastSourceUrl !== m.url ? `<p class="meta">API: <a href="${escapeAttr(m.lastSourceUrl)}" target="_blank" rel="noopener">${escapeHtml(m.lastSourceUrl)}</a></p>` : ''}
        <p class="status ${escapeAttr(m.lastStatus || 'pending')}">${statusLabel(m.lastStatus)} · última checagem ${formatDate(m.lastCheckedAt)}</p>
        ${m.lastError ? `<p class="meta">Aviso: ${escapeHtml(m.lastError)}</p>` : ''}
        <div class="actions">
          <button class="btn small" data-action="check">Verificar agora</button>
          <button class="btn small" data-action="toggle">${m.enabled ? 'Pausar' : 'Ativar'}</button>
          <button class="btn small danger" data-action="delete">Excluir</button>
        </div>
      </article>`
    )
    .join('');
}

function renderEvents(events) {
  if (!events.length) {
    els.events.innerHTML = `<p class="empty">Nenhuma alteração registrada ainda.</p>`;
    return;
  }

  els.events.innerHTML = events
    .map(
      (e) => `
      <article class="event" data-event-id="${e.id}">
        <h3>${escapeHtml(e.monitorName)}</h3>
        <p class="meta">${formatDate(e.createdAt)} · ${escapeHtml(e.summary || 'Alteração')}</p>
        <div class="actions">
          <button class="btn small" data-action="diff">Ver diff</button>
          <a class="btn small ghost" href="${escapeAttr(e.url)}" target="_blank" rel="noopener">Abrir página</a>
        </div>
      </article>`
    )
    .join('');
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

async function refresh() {
  const [monitors, events, settings] = await Promise.all([
    api('/monitors'),
    api('/events?limit=40'),
    api('/settings'),
  ]);
  renderMonitors(monitors);
  renderEvents(events);
  els.browserNotifications.checked = settings.browserNotifications !== false;
  els.desktopNotifications.checked = settings.desktopNotifications !== false;
  browserNotifyEnabled = settings.browserNotifications !== false;
}

function connectSse() {
  const es = new EventSource('/api/events/stream');
  es.addEventListener('ready', () => {
    els.live.textContent = 'ao vivo';
    els.live.classList.add('live');
  });
  es.addEventListener('change', (ev) => {
    const payload = JSON.parse(ev.data);
    showBrowserNotification(payload);
    refresh().catch(console.error);
  });
  es.addEventListener('status', () => {
    refresh().catch(console.error);
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
      const monitors = await api('/monitors');
      const m = monitors.find((x) => x.id === id);
      await api(`/monitors/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !m.enabled }),
      });
    }
    if (action === 'delete') {
      if (!confirm('Excluir este monitor e seu histórico?')) return;
      await api(`/monitors/${id}`, { method: 'DELETE' });
    }
    await refresh();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

els.events.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action="diff"]');
  if (!btn) return;
  const id = btn.closest('.event')?.dataset.eventId;
  if (!id) return;
  try {
    const event = await api(`/events/${id}`);
    els.diffTitle.textContent = `${event.monitorName} · ${formatDate(event.createdAt)}`;
    els.diffContent.textContent = event.diffText || event.contentPreview || 'Sem diff disponível.';
    els.diffDialog.showModal();
  } catch (err) {
    alert(err.message);
  }
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
