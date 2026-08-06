import { bindLogoPicker } from './brand.js';

bindLogoPicker();

const $ = (sel) => document.querySelector(sel);

const els = {
  form: $('#monitor-form'),
  monitors: $('#monitors'),
  live: $('#live-pill'),
  btnNotify: $('#btn-notify'),
  btnInstall: $('#btn-install'),
  btnLogout: $('#btn-logout'),
  navAdmin: $('#nav-admin'),
  navBilling: $('#nav-billing'),
  userEmail: $('#user-email'),
  quotaHint: $('#quota-hint'),
  notifyStatus: $('#notify-status'),
  btnBrowserNotify: $('#btn-browser-notify'),
  btnDesktopNotify: $('#btn-desktop-notify'),
  btnEmailNotify: $('#btn-email-notify'),
  emailNotifyBox: $('#email-notify-box'),
  emailNotifyStatus: $('#email-notify-status'),
  plansGrid: $('#plans-grid'),
  billingStatus: $('#billing-status'),
  billingFlash: $('#billing-flash'),
  billingAdminFlash: $('#billing-admin-flash'),
  pixDialog: $('#pix-dialog'),
  pixTitle: $('#pix-title'),
  pixSummary: $('#pix-summary'),
  pixClose: $('#pix-close'),
  pixQrImg: $('#pix-qr-img'),
  pixWaiting: $('#pix-waiting'),
  pixCopyCode: $('#pix-copy-code'),
  pixCopyBtn: $('#pix-copy-btn'),
  pixStatus: $('#pix-status'),
  emailPlansDialog: $('#email-plans-dialog'),
  emailPlansClose: $('#email-plans-close'),
  emailPlansGo: $('#email-plans-go'),
  mpConfigForm: $('#mp-config-form'),
  mpAccessToken: $('#mp-access-token'),
  mpPublicKey: $('#mp-public-key'),
  mpWebhookSecret: $('#mp-webhook-secret'),
  mpEnabled: $('#mp-enabled'),
  trialConfigForm: $('#trial-config-form'),
  billingTrialDays: $('#billing-trial-days'),
  billingTrialEmails: $('#billing-trial-emails'),
  billingTrialSites: $('#billing-trial-sites'),
  mpWebhookUrl: $('#mp-webhook-url'),
  reconcileForm: $('#reconcile-form'),
  mpReconcileId: $('#mp-reconcile-id'),
  plansAdminForm: $('#plans-admin-form'),
  plansAdminList: $('#plans-admin-list'),
  btnAddPlan: $('#btn-add-plan'),
  billingUsersList: $('#billing-users-list'),
  billingPaymentsList: $('#billing-payments-list'),
  diffDialog: $('#diff-dialog'),
  diffTitle: $('#diff-title'),
  diffSummary: $('#diff-summary'),
  diffView: $('#diff-view'),
  diffClose: $('#diff-close'),
  pickerDialog: $('#picker-dialog'),
  pickerClose: $('#picker-close'),
  pickerFrame: $('#picker-frame'),
  pickerLoading: $('#picker-loading'),
  pickerSelector: $('#picker-selector'),
  pickerSample: $('#picker-sample'),
  pickerApply: $('#picker-apply'),
  pickerReload: $('#picker-reload'),
  btnPickRegion: $('#btn-pick-region'),
  btnClearSelector: $('#btn-clear-selector'),
  selectorHint: $('#selector-hint'),
  viewTitle: $('#view-title'),
  dashStats: $('#dash-stats'),
  dashFeed: $('#dash-feed'),
  usersList: $('#users-list'),
  adminFlash: $('#admin-flash'),
  mailStatus: $('#mail-status'),
};

let deferredInstall = null;
let browserNotifyEnabled = true;
let desktopNotifyEnabled = true;
let cachedMonitors = [];
let cachedEvents = [];
let currentUser = null;
let currentView = 'dashboard';
let cachedUsers = [];
let cachedPlans = [];
let cachedTrialMaxMonitors = 5;
let cachedBillingUsers = [];
const expandedIds = new Set();
const expandedDashIds = new Set();
const expandedAdminUserIds = new Set();
const expandedBillingUserIds = new Set();

const VIEW_TITLES = {
  dashboard: 'Painel',
  monitors: 'Monitores',
  billing: 'Planos',
  admin: 'Admin',
  'billing-admin': 'Cobranças',
};

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    window.location.href = '/login.html';
    throw new Error('Não autenticado');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 402 && data.code === 'PAYMENT_REQUIRED') {
    if (currentUser) currentUser = { ...currentUser, accessRestricted: true };
    enforceAccessGate();
    const err = new Error(data.error || 'Pagamento necessário');
    err.code = 'PAYMENT_REQUIRED';
    throw err;
  }
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

function enforceAccessGate() {
  if (!currentUser?.accessRestricted || currentUser?.role === 'admin') {
    document.body.classList.remove('access-restricted');
    return;
  }
  document.body.classList.add('access-restricted');
  if (currentView !== 'billing') setView('billing');
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

function ts(value) {
  const n = Date.parse(value || '');
  return Number.isFinite(n) ? n : 0;
}

function sortMonitors(monitors) {
  return [...monitors].sort((a, b) => {
    const byChange = ts(b.lastChangedAt) - ts(a.lastChangedAt);
    if (byChange) return byChange;
    const byCheck = ts(b.lastCheckedAt) - ts(a.lastCheckedAt);
    if (byCheck) return byCheck;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

function eventsForMonitor(monitorId) {
  return cachedEvents.filter((e) => e.monitorId === monitorId);
}

function changesLabel(count) {
  if (count === 1) return '1 alteração';
  return `${count} alterações`;
}

function setView(view) {
  if (currentUser?.accessRestricted && currentUser?.role !== 'admin' && view !== 'billing') {
    view = 'billing';
  }
  if ((view === 'admin' || view === 'billing-admin') && currentUser?.role !== 'admin') {
    view = 'dashboard';
  }
  currentView = view;
  if (location.hash.replace('#', '').split('?')[0] !== view) {
    history.replaceState(null, '', `#${view}`);
  }
  document.querySelectorAll('.side-link').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.view === view);
  });
  document.querySelectorAll('.view').forEach((section) => {
    const active = section.id === `view-${view}`;
    section.classList.toggle('is-active', active);
  });
  if (els.viewTitle) els.viewTitle.textContent = VIEW_TITLES[view] || view;
  if (view === 'admin') refreshAdmin().catch((err) => adminFlash(err.message, true));
  if (view === 'billing') refreshBilling().catch(console.error);
  if (view === 'billing-admin') {
    refreshBillingAdmin().catch((err) => billingAdminFlash(err.message, true));
  }
  if (view === 'dashboard') renderDashboard();
}

function emailNotifyLabel(status) {
  return (
    {
      off: 'Desativado',
      pending: 'Aguardando aprovação do admin',
      approved: 'Aprovado — e-mails ativos',
    }[status] || status
  );
}

function hasPaidEmailAccess(user = currentUser) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.emailNotifyAllowed === true) return true;
  const billing = user.billing || {};
  return (
    billing.entitled === true &&
    (billing.source === 'paid' || billing.source === 'permanent' || billing.source === 'admin')
  );
}

function syncEmailNotifyUi(user) {
  if (!els.emailNotifyBox) return;
  els.emailNotifyBox.hidden = false;
  const billing = user?.billing || {};
  const emailOk = hasPaidEmailAccess(user);
  const status = user?.emailNotifyStatus || 'off';
  const dailyLimit = user?.emailNotifyDailyLimit ?? 10;
  const sentToday = user?.emailNotifySentToday ?? 0;
  const emailOn = emailOk && status === 'approved';

  if (els.btnEmailNotify) {
    els.btnEmailNotify.classList.toggle('is-locked', !emailOk);
    els.btnEmailNotify.classList.toggle('is-on', emailOn);
    els.btnEmailNotify.classList.toggle('is-off', emailOk && !emailOn);
  }

  if (els.btnBrowserNotify) {
    els.btnBrowserNotify.classList.toggle('is-on', browserNotifyEnabled);
    els.btnBrowserNotify.classList.toggle('is-off', !browserNotifyEnabled);
  }
  if (els.btnDesktopNotify) {
    els.btnDesktopNotify.classList.toggle('is-on', desktopNotifyEnabled);
    els.btnDesktopNotify.classList.toggle('is-off', !desktopNotifyEnabled);
  }

  if (els.emailNotifyStatus) {
    if (!emailOk) {
      els.emailNotifyStatus.textContent =
        billing.status === 'trial'
          ? `Trial ativo até ${formatDate(billing.expiresAt)}. E-mail só em planos pagos — clique para ver os planos.`
          : 'Somente planos pagos enviam alertas por e-mail. Clique para escolher um plano.';
      els.emailNotifyStatus.classList.add('warn-text');
    } else {
      els.emailNotifyStatus.textContent = `Plano ativo${
        billing.expiresAt ? ` até ${formatDate(billing.expiresAt)}` : ''
      } · Limite hoje: ${sentToday}/${dailyLimit}${
        emailOn ? ' · e-mail ligado' : ' · clique para ativar e-mail'
      }`;
      els.emailNotifyStatus.classList.remove('warn-text');
    }
  }

  if (els.billingStatus && user?.billing) {
    const map = {
      trial: 'Período gratuito',
      active: 'Assinatura ativa',
      expired: 'Expirado',
      inactive: 'Cobrança desativada',
    };
    els.billingStatus.textContent = `${map[billing.status] || billing.status || '—'}${
      billing.expiresAt ? ` · válido até ${formatDate(billing.expiresAt)}` : ''
    }`;
  }
}

function syncQuotaUi(quota) {
  if (!els.quotaHint || !quota) return;
  els.quotaHint.hidden = false;
  els.quotaHint.textContent = `Sites: ${quota.used} de ${quota.maxMonitors} disponíveis.`;
}

function applyAccountUser(user) {
  if (!user?.id) return;
  const idx = cachedUsers.findIndex((u) => u.id === user.id);
  if (idx >= 0) cachedUsers[idx] = { ...cachedUsers[idx], ...user };
  else if (currentUser?.role === 'admin') cachedUsers = [...cachedUsers, user];

  if (currentUser?.id === user.id) {
    currentUser = { ...currentUser, ...user };
    syncEmailNotifyUi(currentUser);
    enforceAccessGate();
    if (els.quotaHint && user.maxMonitors != null && user.monitorCount != null) {
      syncQuotaUi({ used: user.monitorCount, maxMonitors: user.maxMonitors });
    }
    if (currentView === 'billing') renderPlans(cachedPlans);
  }

  if (currentView === 'admin' && currentUser?.role === 'admin') {
    renderUsers(cachedUsers);
  }
}

async function refreshSessionUi() {
  try {
    const me = await api('/auth/me');
    currentUser = me.user;
    syncEmailNotifyUi(currentUser);
    if (me.user?.accessRestricted && me.user?.role !== 'admin') {
      enforceAccessGate();
      return;
    }
    document.body.classList.remove('access-restricted');
    syncQuotaUi(me.quota);
  } catch {
    /* ignore */
  }
}

function updateNotifyUi() {
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const map = {
    granted: 'concedida',
    denied: 'negada',
    default: 'ainda não pedida',
    unsupported: 'não suportada neste navegador',
  };
  if (els.notifyStatus) {
    els.notifyStatus.textContent = `Permissão do navegador: ${map[perm] || perm}`;
  }
  els.btnNotify.textContent =
    perm === 'granted' ? 'Alertas ativos' : 'Ativar alertas';
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
  const ordered = sortMonitors(monitors);
  cachedMonitors = ordered;
  if (!ordered.length) {
    els.monitors.innerHTML = `<p class="empty">Nenhum monitor ainda. Adicione a primeira URL ao lado.</p>`;
    return;
  }

  const showUpgradePromo = !hasPaidEmailAccess(currentUser) && ordered.length >= 2;
  const cardsHtml = ordered
    .map((m, index) => {
      const open = expandedIds.has(m.id);
      const events = eventsForMonitor(m.id);
      const card = `
      <article class="card accordion ${open ? 'is-open' : ''}" data-id="${m.id}">
        <button type="button" class="accordion-trigger" data-action="toggle-expand" aria-expanded="${open}">
          <span class="chevron" aria-hidden="true"></span>
          <span class="accordion-title">
            <strong>${escapeHtml(m.name)}</strong>
            <span class="accordion-meta">${changesLabel(events.length)}</span>
          </span>
          <span class="status ${escapeAttr(m.lastStatus || 'pending')}">${statusLabel(m.lastStatus)}</span>
        </button>

        <div class="accordion-summary">
          <p class="meta"><a href="${escapeAttr(m.url)}" target="_blank" rel="noopener">${escapeHtml(m.url)}</a></p>
          <p class="meta">A cada ${m.intervalMinutes} min${m.selector ? ` · seletor <code>${escapeHtml(m.selector)}</code>` : ''}${m.lastContentKind ? ` · fonte <code>${escapeHtml(m.lastContentKind)}</code>` : ''}${
            m.pendingHashCount
              ? ` · confirmando ${Number(m.pendingHashCount)}/2`
              : ''
          }</p>
          ${m.lastSourceUrl && m.lastSourceUrl !== m.url ? `<p class="meta">API: <a href="${escapeAttr(m.lastSourceUrl)}" target="_blank" rel="noopener">${escapeHtml(m.lastSourceUrl)}</a></p>` : ''}
          <p class="meta">Última alteração ${formatDate(m.lastChangedAt)}</p>
          <p class="meta">Última checagem ${formatDate(m.lastCheckedAt)}</p>
          ${
            m.lastError
              ? `<p class="meta${m.lastStatus === 'error' ? ' warn-text' : ''}">${
                  m.lastStatus === 'error' ? 'Aviso: ' : ''
                }${escapeHtml(m.lastError)}</p>`
              : ''
          }
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
      if (showUpgradePromo && index === 1) {
        return (
          card +
          `
      <aside class="upgrade-promo" role="note">
        <p>
          Para cadastrar mais sites e receber por e-mail suas notificações, escolha um de nossos planos.
        </p>
        <button type="button" class="btn primary" data-action="go-plans">Ver planos e pagar</button>
      </aside>`
        );
      }
      return card;
    })
    .join('');

  els.monitors.innerHTML = cardsHtml;
}

function renderDashboard() {
  if (!els.dashFeed || !els.dashStats) return;
  const changed = cachedMonitors.filter((m) => m.lastChangedAt).length;
  const errors = cachedMonitors.filter((m) => m.lastStatus === 'error').length;
  const recent = [...cachedEvents].sort((a, b) => ts(b.createdAt) - ts(a.createdAt)).slice(0, 40);

  els.dashStats.innerHTML = `
    <article class="stat-card"><p class="stat-label">Monitores</p><p class="stat-value">${cachedMonitors.length}</p></article>
    <article class="stat-card"><p class="stat-label">Com alteração</p><p class="stat-value">${changed}</p></article>
    <article class="stat-card"><p class="stat-label">Com erro</p><p class="stat-value">${errors}</p></article>
    <article class="stat-card"><p class="stat-label">Eventos recentes</p><p class="stat-value">${recent.length}</p></article>
  `;

  if (!recent.length) {
    els.dashFeed.innerHTML = `<p class="empty">Nenhuma alteração registrada ainda.</p>`;
    return;
  }

  const groups = new Map();
  for (const e of recent) {
    const key = e.monitorId || e.monitorName || e.id;
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        name: e.monitorName || 'Monitor',
        url: e.url || '',
        events: [],
      });
    }
    groups.get(key).events.push(e);
  }

  const ordered = [...groups.values()].sort(
    (a, b) => ts(b.events[0]?.createdAt) - ts(a.events[0]?.createdAt)
  );

  els.dashFeed.innerHTML = ordered
    .map((group) => {
      const open = expandedDashIds.has(group.id);
      const latest = group.events[0];
      return `
      <article class="card accordion dash-group ${open ? 'is-open' : ''}" data-dash-id="${escapeAttr(group.id)}">
        <button type="button" class="accordion-trigger" data-action="toggle-dash" aria-expanded="${open}">
          <span class="chevron" aria-hidden="true"></span>
          <span class="accordion-title">
            <strong>${escapeHtml(group.name)}</strong>
            <span class="accordion-meta">${changesLabel(group.events.length)} · última ${formatDate(latest?.createdAt)}</span>
          </span>
        </button>
        <div class="accordion-summary">
          <p class="event-summary">${escapeHtml(latest?.summary || 'Alteração detectada')}</p>
          ${group.url ? `<p class="meta"><a href="${escapeAttr(group.url)}" target="_blank" rel="noopener">${escapeHtml(group.url)}</a></p>` : ''}
        </div>
        <div class="accordion-panel" ${open ? '' : 'hidden'}>
          <div class="events">
            ${group.events
              .map(
                (e) => `
              <article class="event" data-event-id="${escapeAttr(e.id)}">
                <div class="event-main">
                  <p class="event-time">${formatDate(e.createdAt)}</p>
                  <p class="event-summary">${escapeHtml(e.summary || 'Alteração detectada')}</p>
                </div>
                <div class="actions">
                  <button class="btn small" data-action="diff" type="button">Ver diff</button>
                  <a class="btn small ghost" href="${escapeAttr(e.url)}" target="_blank" rel="noopener">Abrir</a>
                </div>
              </article>`
              )
              .join('')}
          </div>
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

function collectSide(changes, side) {
  const blocks = [];
  for (const group of changes || []) {
    const lines = [];
    for (const item of group.items || []) {
      const value = side === 'before' ? item.from : item.to;
      if (value == null || value === '') continue;
      if (item.label === 'Antes' || item.label === 'Depois') lines.push(String(value));
      else lines.push(`${item.label}: ${value}`);
    }
    if (lines.length) blocks.push({ title: group.title, lines });
  }
  return blocks;
}

function renderSide(title, blocks, side) {
  const body = blocks.length
    ? blocks
        .map(
          (block) => `
        <article class="side-card">
          <h4>${escapeHtml(block.title)}</h4>
          <ul>${block.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
        </article>`
        )
        .join('')
    : `<p class="empty">Sem alterações neste lado.</p>`;

  return `
    <section class="diff-pane diff-pane--${side}">
      <header class="diff-pane__head">${title}</header>
      <div class="diff-pane__body">${body}</div>
    </section>`;
}

function openDiff(event) {
  const changes = Array.isArray(event.changes) ? event.changes : [];
  els.diffTitle.textContent = `${event.monitorName} · ${formatDate(event.createdAt)}`;
  els.diffSummary.textContent = event.summary || 'Alterações detectadas';

  const beforeBlocks = collectSide(changes, 'before');
  const afterBlocks = collectSide(changes, 'after');

  if (!beforeBlocks.length && !afterBlocks.length) {
    els.diffView.innerHTML = `${originLabel(event)}<p class="empty">Não há detalhes legíveis para esta alteração.</p>`;
  } else {
    els.diffView.innerHTML = `
      ${originLabel(event)}
      <div class="diff-compare">
        ${renderSide('Antes', beforeBlocks, 'before')}
        ${renderSide('Depois', afterBlocks, 'after')}
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
  renderDashboard();
  browserNotifyEnabled = settings.browserNotifications !== false;
  desktopNotifyEnabled = settings.desktopNotifications !== false;
  syncEmailNotifyUi(currentUser);
}

function adminFlash(message, isError = false) {
  if (!els.adminFlash) return;
  els.adminFlash.hidden = false;
  els.adminFlash.textContent = message;
  els.adminFlash.classList.toggle('warn-text', isError);
}

function renderUsers(users) {
  cachedUsers = users;
  if (!els.usersList) return;
  if (!users.length) {
    els.usersList.innerHTML = `<p class="empty">Nenhum usuário cadastrado.</p>`;
    return;
  }
  els.usersList.innerHTML = users
    .map((u) => {
      const pending = u.resetPending
        ? `<p class="meta warn-text">Recuperação pendente desde ${formatDate(u.resetRequestedAt)}</p>`
        : '';
      const emailStatus = u.emailNotifyStatus || 'off';
      const open = expandedAdminUserIds.has(u.id);
      const sitesUsed = Number(u.monitorCount) || 0;
      const sitesMax = Number(u.maxMonitors) || 0;
      const mailUsed = Number(u.emailNotifySentToday) || 0;
      const mailMax = Number(u.emailNotifyDailyLimit ?? 10);
      return `
      <article class="card user-card user-card-compact${open ? ' is-open' : ''}" data-id="${escapeHtml(u.id)}">
        <button type="button" class="user-card-toggle" data-action="toggle-user-card" aria-expanded="${open}">
          <div class="user-card-main">
            <strong title="${escapeHtml(u.email)}">${escapeHtml(u.email)}</strong>
            <p class="meta">${u.role === 'admin' ? 'Administrador' : 'Usuário'} · ${formatDate(u.createdAt)}</p>
            ${pending}
          </div>
          <span class="chevron" aria-hidden="true"></span>
          <div class="user-usage-summary">
            <span>Sites <strong>${sitesUsed}/${sitesMax}</strong></span>
            <span>E-mail <strong>${mailUsed}/${mailMax}</strong></span>
            <span class="status ${u.active ? 'ok' : 'error'}">${u.active ? 'ativa' : 'off'}</span>
          </div>
        </button>
        <div class="user-card-body"${open ? '' : ' hidden'}>
          <div class="user-grid">
            <label>
              Limite de sites
              <input type="number" min="0" max="1000" class="max-monitors" value="${sitesMax}" />
            </label>
            <p class="meta usage">Em uso: <strong>${sitesUsed}</strong> / ${sitesMax}</p>
          </div>
          <div class="email-admin-box">
            <label class="check">
              <input type="checkbox" class="email-allowed" ${u.emailNotifyAllowed ? 'checked' : ''} data-action="toggle-email-allow" />
              Liberar opção de notificação por e-mail
            </label>
            <label>
              Limite de e-mails por dia
              <input type="number" min="0" max="500" class="email-daily-limit" value="${mailMax}" />
            </label>
            <p class="meta">
              Pedido do usuário: <strong>${emailNotifyLabel(emailStatus)}</strong>
              · hoje ${mailUsed}/${mailMax}
            </p>
            <div class="actions wrap">
              <button type="button" class="btn small" data-action="save-email-limit">Salvar limite e-mail</button>
              ${
                emailStatus === 'pending'
                  ? `<button type="button" class="btn small" data-action="approve-email">Aprovar e-mail</button>
                     <button type="button" class="btn small danger" data-action="reject-email">Recusar</button>`
                  : ''
              }
              ${
                emailStatus === 'approved'
                  ? `<button type="button" class="btn small danger" data-action="revoke-email">Revogar e-mail</button>`
                  : ''
              }
            </div>
          </div>
          <label class="check permanent-check">
            <input type="checkbox" class="billing-permanent" ${u.billingPermanent ? 'checked' : ''} data-action="toggle-permanent" />
            Ativar permanentemente (sem expiração de plano)
          </label>
          <div class="actions wrap">
            <button type="button" class="btn small" data-action="save-limit">Salvar limite</button>
            <button type="button" class="btn small" data-action="toggle">${u.active ? 'Desativar' : 'Ativar'}</button>
            <button type="button" class="btn small" data-action="password">Nova senha</button>
            <button type="button" class="btn small" data-action="reset-link">Copiar link</button>
            <button type="button" class="btn small" data-action="send-email">Enviar e-mail</button>
            ${u.role === 'admin' ? '' : `<button type="button" class="btn small danger" data-action="delete">Excluir</button>`}
          </div>
          <p class="hint reset-link-box" hidden></p>
        </div>
      </article>`;
    })
    .join('');
}

async function refreshAdmin() {
  const data = await api('/admin/users');
  if (els.mailStatus) {
    if (data.mail?.configured) {
      els.mailStatus.textContent = `E-mail ativo (${data.mail.provider}).`;
      els.mailStatus.classList.remove('warn-text');
    } else {
      els.mailStatus.textContent = 'E-mail não configurado (BREVO_API_KEY / MAIL_FROM).';
      els.mailStatus.classList.add('warn-text');
    }
  }
  renderUsers(data.users || []);
}

function applyMonitorPatch(patch) {
  if (!patch?.id) return false;
  const idx = cachedMonitors.findIndex((m) => m.id === patch.id);
  if (idx < 0) return false;
  cachedMonitors[idx] = { ...cachedMonitors[idx], ...patch };
  return true;
}

function connectSse() {
  let statusTimer = null;
  let refreshTimer = null;
  let pollTimer = null;
  let es = null;

  const scheduleRefresh = (ms = 400) => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refresh().catch(console.error);
    }, ms);
  };

  const bind = () => {
    if (es) {
      try {
        es.close();
      } catch {
        /* ignore */
      }
    }
    es = new EventSource('/api/events/stream', { withCredentials: true });

    es.addEventListener('ready', () => {
      els.live.textContent = 'ao vivo';
      els.live.classList.add('live');
    });

    es.addEventListener('change', (ev) => {
      let payload = {};
      try {
        payload = JSON.parse(ev.data);
      } catch {
        /* ignore */
      }
      showBrowserNotification(payload);
      if (payload.monitor?.id) {
        expandedIds.add(payload.monitor.id);
        applyMonitorPatch(payload.monitor);
        if (payload.event) {
          cachedEvents = [payload.event, ...cachedEvents.filter((e) => e.id !== payload.event.id)];
        }
        renderMonitors(cachedMonitors);
        renderDashboard();
      }
      scheduleRefresh(250);
    });

    es.addEventListener('status', (ev) => {
      let payload = {};
      try {
        payload = JSON.parse(ev.data);
      } catch {
        /* ignore */
      }
      if (payload.monitor?.id) {
        applyMonitorPatch(payload.monitor);
        renderMonitors(cachedMonitors);
        if (currentView === 'dashboard') renderDashboard();
      }
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => scheduleRefresh(100), 300);
    });

    es.addEventListener('account', (ev) => {
      let payload = {};
      try {
        payload = JSON.parse(ev.data);
      } catch {
        /* ignore */
      }
      if (payload.user) applyAccountUser(payload.user);
      if (payload.user && currentUser?.id === payload.user.id) {
        refreshSessionUi().catch(() => {});
      }
      if (currentUser?.role === 'admin' && currentView === 'admin') {
        refreshAdmin().catch(console.error);
      }
    });

    es.onerror = () => {
      els.live.textContent = 'reconectando…';
      els.live.classList.remove('live');
    };
  };

  bind();

  // Backup polling so the UI never stays stale if SSE drops.
  pollTimer = setInterval(() => {
    if (document.hidden) return;
    refresh().catch(console.error);
  }, 5000);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh().catch(console.error);
  });

  return () => {
    clearTimeout(statusTimer);
    clearTimeout(refreshTimer);
    clearInterval(pollTimer);
    es?.close();
  };
}

document.querySelectorAll('.side-link').forEach((btn) => {
  btn.addEventListener('click', () => setView(btn.dataset.view));
});

window.addEventListener('hashchange', () => {
  const view = (location.hash.replace('#', '') || 'dashboard').split('?')[0];
  setView(view);
});

els.form?.addEventListener('submit', async (e) => {
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
    updateSelectorHint('');
    try {
      const me = await api('/auth/me');
      if (els.quotaHint && me.quota) {
        els.quotaHint.hidden = false;
        els.quotaHint.textContent = `Sites: ${me.quota.used} de ${me.quota.maxMonitors} disponíveis.`;
      }
    } catch {
      /* ignore */
    }
    await refresh();
    setView('monitors');
  } catch (err) {
    alert(err.message);
  }
});

let pickerSelected = null;

function updateSelectorHint(selector) {
  if (!els.selectorHint) return;
  if (selector) {
    els.selectorHint.textContent = `Monitorando só: ${selector}`;
  } else {
    els.selectorHint.textContent =
      'Sem seletor, monitora a página toda (no SEI, andamentos/protocolos).';
  }
}

function resetPickerUi() {
  pickerSelected = null;
  if (els.pickerSelector) els.pickerSelector.textContent = 'Nenhuma área selecionada';
  if (els.pickerSample) els.pickerSample.textContent = '';
  if (els.pickerApply) els.pickerApply.disabled = true;
}

function loadPickerFrame(url) {
  if (!els.pickerFrame) return;
  resetPickerUi();
  if (els.pickerLoading) els.pickerLoading.hidden = false;
  const src = `/api/preview/frame?url=${encodeURIComponent(url)}&t=${Date.now()}`;
  els.pickerFrame.onload = () => {
    if (els.pickerLoading) els.pickerLoading.hidden = true;
  };
  els.pickerFrame.src = src;
}

function openRegionPicker() {
  const url = $('#url')?.value.trim();
  if (!url) {
    alert('Informe a URL do site antes de selecionar a área.');
    $('#url')?.focus();
    return;
  }
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('bad');
  } catch {
    alert('URL inválida. Use http:// ou https://');
    return;
  }
  if (!els.pickerDialog) return;
  loadPickerFrame(url);
  els.pickerDialog.showModal();
}

function closeRegionPicker() {
  els.pickerDialog?.close();
  if (els.pickerFrame) els.pickerFrame.src = 'about:blank';
  resetPickerUi();
}

els.btnPickRegion?.addEventListener('click', openRegionPicker);
els.btnClearSelector?.addEventListener('click', () => {
  const input = $('#selector');
  if (input) input.value = '';
  updateSelectorHint('');
});
els.pickerClose?.addEventListener('click', closeRegionPicker);
els.pickerReload?.addEventListener('click', () => {
  const url = $('#url')?.value.trim();
  if (url) loadPickerFrame(url);
});
els.pickerApply?.addEventListener('click', () => {
  if (!pickerSelected?.selector) return;
  const input = $('#selector');
  if (input) input.value = pickerSelected.selector;
  updateSelectorHint(pickerSelected.selector);
  closeRegionPicker();
});
els.pickerDialog?.addEventListener('close', () => {
  if (els.pickerFrame) els.pickerFrame.src = 'about:blank';
});

window.addEventListener('message', (event) => {
  if (!els.pickerDialog?.open) return;
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'monitorweb-pick-cancel') {
    closeRegionPicker();
    return;
  }
  if (data.type !== 'monitorweb-pick') return;
  const selector = String(data.selector || '').trim();
  if (!selector) return;
  pickerSelected = {
    selector,
    text: String(data.text || '').trim(),
  };
  if (els.pickerSelector) els.pickerSelector.textContent = selector;
  if (els.pickerSample) {
    els.pickerSample.textContent = pickerSelected.text
      ? `Prévia: ${pickerSelected.text}`
      : '(região sem texto visível — o monitoramento usará o HTML dessa área)';
  }
  if (els.pickerApply) els.pickerApply.disabled = false;
});

$('#selector')?.addEventListener('input', (e) => {
  updateSelectorHint(e.target.value.trim());
});

async function handleDiffClick(eventId) {
  if (!eventId) return;
  const event = await api(`/events/${eventId}`);
  openDiff(event);
}

els.monitors?.addEventListener('click', async (e) => {
  const goPlans = e.target.closest('[data-action="go-plans"]');
  if (goPlans) {
    setView('billing');
    return;
  }

  const expandBtn = e.target.closest('[data-action="toggle-expand"]');
  if (expandBtn) {
    const id = expandBtn.closest('.card')?.dataset.id;
    if (!id) return;
    if (expandedIds.has(id)) expandedIds.delete(id);
    else expandedIds.add(id);
    renderMonitors(cachedMonitors);
    return;
  }

  const diffBtn = e.target.closest('button[data-action="diff"]');
  if (diffBtn) {
    try {
      await handleDiffClick(diffBtn.closest('.event')?.dataset.eventId);
    } catch (err) {
      alert(err.message);
    }
    return;
  }

  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.closest('.card')?.dataset.id;
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

els.dashFeed?.addEventListener('click', async (e) => {
  const toggle = e.target.closest('[data-action="toggle-dash"]');
  if (toggle) {
    const id = toggle.closest('[data-dash-id]')?.dataset.dashId;
    if (!id) return;
    if (expandedDashIds.has(id)) expandedDashIds.delete(id);
    else expandedDashIds.add(id);
    renderDashboard();
    return;
  }

  const diffBtn = e.target.closest('button[data-action="diff"]');
  if (!diffBtn) return;
  try {
    await handleDiffClick(diffBtn.closest('[data-event-id]')?.dataset.eventId);
  } catch (err) {
    alert(err.message);
  }
});

els.usersList?.addEventListener('click', async (e) => {
  const toggleCard = e.target.closest('[data-action="toggle-user-card"]');
  if (toggleCard) {
    const card = toggleCard.closest('.user-card');
    const id = card?.dataset.id;
    if (!id) return;
    if (expandedAdminUserIds.has(id)) expandedAdminUserIds.delete(id);
    else expandedAdminUserIds.add(id);
    renderUsers(cachedUsers);
    return;
  }

  const permanentBox = e.target.closest('.billing-permanent');
  if (permanentBox && permanentBox.dataset.action === 'toggle-permanent') {
    const card = permanentBox.closest('.user-card');
    const id = card?.dataset.id;
    if (!id) return;
    const next = permanentBox.checked;
    try {
      const data = await api(`/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ billingPermanent: next, billingActive: true }),
      });
      if (data.user) applyAccountUser(data.user);
      adminFlash(next ? 'Usuário ativado permanentemente.' : 'Ativação permanente removida.');
      await refreshAdmin();
    } catch (err) {
      permanentBox.checked = !next;
      adminFlash(err.message, true);
    }
    return;
  }

  const allowBox =
    e.target.closest('.email-allowed') ||
    e.target.closest('label.check')?.querySelector('.email-allowed');
  if (allowBox) {
    e.stopPropagation();
    const card = allowBox.closest('.user-card');
    const id = card?.dataset.id;
    if (!id) return;
    const user = cachedUsers.find((u) => u.id === id);
    // Prefer the checkbox's current value after the native toggle.
    const next = allowBox.checked;
    try {
      const data = await api(`/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          emailNotifyAllowed: next,
          ...(next ? {} : { emailNotifyStatus: 'off' }),
        }),
      });
      if (data.user) {
        applyAccountUser(data.user);
        const idx = cachedUsers.findIndex((u) => u.id === id);
        if (idx >= 0) cachedUsers[idx] = { ...cachedUsers[idx], ...data.user };
      }
      adminFlash(
        next
          ? `Opção de e-mail liberada para ${user?.email || 'usuário'}. Peça ao usuário para marcar a caixa em Monitores.`
          : `Opção de e-mail bloqueada para ${user?.email || 'usuário'}.`
      );
      // Keep card open and avoid full remount flicker when possible.
      if (expandedAdminUserIds.has(id) && data.user) {
        renderUsers(cachedUsers);
      } else {
        await refreshAdmin();
      }
      await refreshSessionUi();
    } catch (err) {
      allowBox.checked = !next;
      adminFlash(err.message, true);
    }
    return;
  }

  const btn = e.target.closest('[data-action]');
  if (!btn || btn.dataset.action === 'toggle-user-card') return;
  const card = btn.closest('.user-card');
  const id = card?.dataset.id;
  if (!id) return;
  const user = cachedUsers.find((u) => u.id === id);
  const action = btn.dataset.action;
  btn.disabled = true;
  try {
    if (action === 'save-limit') {
      const maxMonitors = Number(card.querySelector('.max-monitors').value);
      const data = await api(`/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ maxMonitors }),
      });
      if (data.user) applyAccountUser(data.user);
      adminFlash(`Limite de sites de ${user.email} atualizado.`);
    }
    if (action === 'save-email-limit') {
      const emailNotifyDailyLimit = Number(card.querySelector('.email-daily-limit').value);
      const data = await api(`/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ emailNotifyDailyLimit }),
      });
      if (data.user) applyAccountUser(data.user);
      adminFlash(`Limite diário de e-mails de ${user.email}: ${emailNotifyDailyLimit}.`);
    }
    if (action === 'toggle-email-allow') {
      // handled by checkbox above
    }
    if (action === 'approve-email') {
      const data = await api(`/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ emailNotifyAllowed: true, emailNotifyStatus: 'approved' }),
      });
      if (data.user) applyAccountUser(data.user);
      adminFlash(`Notificações por e-mail aprovadas para ${user.email}.`);
    }
    if (action === 'reject-email' || action === 'revoke-email') {
      const data = await api(`/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ emailNotifyStatus: 'off' }),
      });
      if (data.user) applyAccountUser(data.user);
      adminFlash(
        action === 'revoke-email'
          ? `E-mail revogado para ${user.email}.`
          : `Pedido de e-mail recusado para ${user.email}.`
      );
    }
    if (action === 'toggle') {
      const data = await api(`/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !user.active }),
      });
      if (data.user) applyAccountUser(data.user);
      adminFlash(`Conta ${user.email} ${user.active ? 'desativada' : 'ativada'}.`);
    }
    if (action === 'password') {
      const password = prompt(`Nova senha para ${user.email} (mín. 8 caracteres):`);
      if (!password) return;
      await api(`/admin/users/${id}/password`, { method: 'POST', body: JSON.stringify({ password }) });
      adminFlash(`Senha de ${user.email} redefinida.`);
    }
    if (action === 'reset-link' || action === 'send-email') {
      const data = await api(`/admin/users/${id}/reset-link`, {
        method: 'POST',
        body: JSON.stringify({ sendEmail: action === 'send-email' }),
      });
      const box = card.querySelector('.reset-link-box');
      box.hidden = false;
      box.textContent = data.resetUrl;
      if (action === 'send-email') {
        if (data.mailed) adminFlash(`E-mail enviado para ${user.email}.`);
        else adminFlash(data.mailError || 'Falha ao enviar e-mail. Link gerado abaixo.', true);
      } else {
        try {
          await navigator.clipboard.writeText(data.resetUrl);
          adminFlash(`Link copiado para ${user.email}.`);
        } catch {
          adminFlash(`Link gerado para ${user.email}.`);
        }
      }
    }
    if (action === 'delete') {
      if (!confirm(`Excluir ${user.email} e todos os monitores dele?`)) return;
      await api(`/admin/users/${id}`, { method: 'DELETE' });
      cachedUsers = cachedUsers.filter((u) => u.id !== id);
      adminFlash(`Usuário ${user.email} excluído.`);
    }
    await refreshAdmin();
    await refreshSessionUi();
  } catch (err) {
    adminFlash(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

els.diffClose?.addEventListener('click', () => els.diffDialog.close());
els.diffDialog?.addEventListener('click', (e) => {
  if (e.target === els.diffDialog) els.diffDialog.close();
});

els.btnNotify?.addEventListener('click', () => enableBrowserNotifications());

function billingFlash(message, isError = false) {
  if (!els.billingFlash) return;
  els.billingFlash.hidden = false;
  els.billingFlash.textContent = message;
  els.billingFlash.classList.toggle('warn-text', isError);
}

function billingAdminFlash(message, isError = false) {
  if (!els.billingAdminFlash) return;
  els.billingAdminFlash.hidden = false;
  els.billingAdminFlash.textContent = message;
  els.billingAdminFlash.classList.toggle('warn-text', isError);
}

function renderPlans(plans) {
  cachedPlans = plans || [];
  if (!els.plansGrid) return;
  if (!cachedPlans.length) {
    els.plansGrid.innerHTML = `<p class="empty">Nenhum plano disponível no momento.</p>`;
    return;
  }
  const billing = currentUser?.billing || {};
  const activePlanId =
    billing.entitled && (billing.status === 'active' || billing.source === 'paid')
      ? billing.planId || currentUser?.billingPlanId || null
      : null;

  els.plansGrid.innerHTML = cachedPlans
    .map((p) => {
      const isActive = Boolean(activePlanId && p.id === activePlanId);
      const maxSites = Number(p.maxMonitors) || 100;
      const features = Array.isArray(p.features) && p.features.length
        ? p.features
        : ['Alertas por e-mail', `Até ${maxSites} sites para monitoramento`];
      const checkoutLocked = isActive;
      return `
    <article class="plan-card${isActive ? ' is-active' : ''}" data-plan-id="${escapeHtml(p.id)}">
      ${isActive ? `<span class="plan-seal" title="Assinatura vigente">Ativo</span>` : ''}
      <h3>${escapeHtml(p.label)}</h3>
      <p class="plan-price">R$ ${Number(p.price).toFixed(0)} <span>/ ${Number(p.days)} dia(s)</span></p>
      <ul class="plan-features">
        ${features.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}
      </ul>
      <p class="hint">${
        isActive
          ? `Assinatura vigente${billing.expiresAt ? ` até ${formatDate(billing.expiresAt)}` : ''}. Novo Pix só após o vencimento.`
          : `Trial: até ${cachedTrialMaxMonitors} sites. Planos pagos: até 100 sites.`
      }</p>
      <button type="button" class="btn primary" data-action="checkout" data-plan-id="${escapeHtml(p.id)}"${
        checkoutLocked ? ' disabled aria-disabled="true"' : ''
      }>
        ${checkoutLocked ? 'Plano ativo' : 'Pagar com Pix'}
      </button>
    </article>`;
    })
    .join('');
}

async function refreshBilling() {
  const data = await api('/billing/me');
  if (data.billing && currentUser) {
    currentUser = { ...currentUser, billing: data.billing };
    syncEmailNotifyUi(currentUser);
  }
  if (data.trialMaxMonitors != null) {
    cachedTrialMaxMonitors = Number(data.trialMaxMonitors) || 5;
  }
  renderPlans(data.plans || []);
  if (els.billingFlash) {
    // Clear stale redirect messages when subscription is already active.
    if (data.billing?.entitled) {
      els.billingFlash.hidden = true;
      els.billingFlash.textContent = '';
      if (location.hash.includes('status=')) {
        history.replaceState(null, '', '#billing');
      }
    }
  }
}

let pixPollTimer = null;

function stopPixPoll() {
  if (pixPollTimer) {
    clearInterval(pixPollTimer);
    pixPollTimer = null;
  }
}

function closePixDialog() {
  stopPixPoll();
  els.pixDialog?.close();
}

function openPixDialog(payload) {
  if (!els.pixDialog) return;
  const plan = payload.plan || {};
  const amount = Number(plan.price || payload.payment?.amount || 0);
  if (els.pixTitle) els.pixTitle.textContent = 'Pagar com Pix';
  if (els.pixSummary) {
    els.pixSummary.textContent = `R$ ${amount.toFixed(2).replace('.', ',')}`;
  }
  if (els.pixCopyCode) els.pixCopyCode.value = payload.qrCode || '';
  if (els.pixStatus) {
    els.pixStatus.hidden = true;
    els.pixStatus.textContent = '';
  }
  if (els.pixWaiting) {
    els.pixWaiting.hidden = false;
    els.pixWaiting.textContent = 'Aguardando confirmação do pagamento…';
  }

  if (els.pixQrImg) {
    if (payload.qrCodeBase64) {
      els.pixQrImg.src = `data:image/png;base64,${payload.qrCodeBase64}`;
      els.pixQrImg.hidden = false;
    } else {
      els.pixQrImg.hidden = true;
      els.pixQrImg.removeAttribute('src');
    }
  }

  if (!els.pixDialog.open) els.pixDialog.showModal();

  stopPixPoll();
  const localId = payload.payment?.id;
  if (!localId) return;

  pixPollTimer = setInterval(async () => {
    try {
      const st = await api(`/billing/checkout/${localId}/status`);
      if (st.approved || st.activated || st.already) {
        stopPixPoll();
        if (els.pixWaiting) els.pixWaiting.textContent = 'Pagamento confirmado!';
        if (els.pixStatus) {
          els.pixStatus.hidden = false;
          els.pixStatus.textContent = 'Plano liberado.';
        }
        await refreshSessionUi();
        await refreshBilling();
        setTimeout(() => closePixDialog(), 1200);
      } else if (els.pixStatus && st.status && st.status !== 'pending') {
        els.pixStatus.hidden = false;
        els.pixStatus.textContent = `Status: ${st.status}`;
      }
    } catch {
      /* keep polling */
    }
  }, 3000);
}

els.plansGrid?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action="checkout"]');
  if (!btn || btn.disabled) return;
  const planId = btn.dataset.planId;
  const billing = currentUser?.billing || {};
  const activePlanId =
    billing.entitled && (billing.status === 'active' || billing.source === 'paid')
      ? billing.planId || currentUser?.billingPlanId || null
      : null;
  if (activePlanId && planId === activePlanId) {
    billingFlash('Este plano já está ativo. Novo Pix só após o vencimento.', true);
    return;
  }
  const prevLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Gerando Pix…';
  try {
    const data = await api('/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ planId }),
    });
    if (!data.qrCode && !data.qrCodeBase64) {
      billingFlash('Não foi possível gerar o QR Code Pix. Verifique o Mercado Pago.', true);
      return;
    }
    openPixDialog(data);
  } catch (err) {
    billingFlash(err.message, true);
  } finally {
    const stillActive = Boolean(activePlanId && planId === activePlanId);
    btn.disabled = stillActive;
    btn.textContent = stillActive ? 'Plano ativo' : prevLabel || 'Pagar com Pix';
  }
});

els.pixClose?.addEventListener('click', () => closePixDialog());
els.pixDialog?.addEventListener('click', (e) => {
  if (e.target === els.pixDialog) closePixDialog();
});
els.pixCopyBtn?.addEventListener('click', async () => {
  const code = els.pixCopyCode?.value || '';
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    if (els.pixStatus) els.pixStatus.textContent = 'Código Pix copiado.';
  } catch {
    els.pixCopyCode?.select();
    if (els.pixStatus) els.pixStatus.textContent = 'Selecione e copie o código manualmente.';
  }
});

function renderPlansAdmin(plans) {
  if (!els.plansAdminList) return;
  const list = plans?.length
    ? plans
    : [
        { id: 'month', label: '1 mês', days: 30, price: 30, maxMonitors: 100, active: true },
        { id: 'biweek', label: '15 dias', days: 15, price: 20, maxMonitors: 100, active: true },
        { id: 'day', label: '1 dia', days: 1, price: 10, maxMonitors: 100, active: true },
      ];
  els.plansAdminList.innerHTML = list
    .map(
      (p, i) => `
    <div class="plan-admin-row" data-idx="${i}">
      <label>Nome<input type="text" class="plan-label" value="${escapeHtml(p.label || '')}" /></label>
      <label>Dias<input type="number" min="1" class="plan-days" value="${Number(p.days) || 1}" /></label>
      <label>R$<input type="number" min="0" step="0.01" class="plan-price" value="${Number(p.price) || 0}" /></label>
      <label>Sites<input type="number" min="1" max="1000" class="plan-max-monitors" value="${Number(p.maxMonitors) || 100}" /></label>
      <label class="check"><input type="checkbox" class="plan-active" ${p.active !== false ? 'checked' : ''} /> Ativo</label>
      <label class="plan-features-field">Detalhes (1 por linha)
        <textarea class="plan-features" rows="2">${escapeHtml(
          (Array.isArray(p.features) ? p.features : []).join('\n')
        )}</textarea>
      </label>
      <input type="hidden" class="plan-id" value="${escapeHtml(p.id || `plan-${i}`)}" />
    </div>`
    )
    .join('');
}

function collectPlansAdminFromDom() {
  const rows = [...(els.plansAdminList?.querySelectorAll('.plan-admin-row') || [])];
  return rows.map((row, i) => ({
    id: row.querySelector('.plan-id')?.value || `plan-${Date.now()}-${i}`,
    label: row.querySelector('.plan-label')?.value.trim() || '',
    days: Number(row.querySelector('.plan-days')?.value) || 1,
    price: Number(row.querySelector('.plan-price')?.value) || 0,
    maxMonitors: Number(row.querySelector('.plan-max-monitors')?.value) || 100,
    active: Boolean(row.querySelector('.plan-active')?.checked),
    features: String(row.querySelector('.plan-features')?.value || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  }));
}

els.btnAddPlan?.addEventListener('click', () => {
  const plans = collectPlansAdminFromDom();
  const n = plans.length + 1;
  plans.push({
    id: `plan-${Date.now()}`,
    label: `Novo plano ${n}`,
    days: 30,
    price: 30,
    maxMonitors: 100,
    active: true,
    features: ['Alertas por e-mail', 'Até 100 sites para monitoramento'],
  });
  renderPlansAdmin(plans);
  const last = els.plansAdminList?.querySelector('.plan-admin-row:last-child .plan-label');
  last?.focus();
  last?.select();
});

function renderBillingUsers(users) {
  cachedBillingUsers = users || [];
  if (!els.billingUsersList) return;
  els.billingUsersList.innerHTML = cachedBillingUsers
    .map((u) => {
      const b = u.billing || {};
      const open = expandedBillingUserIds.has(u.id);
      const sitesUsed = Number(u.monitorCount) || 0;
      const sitesMax = Number(u.maxMonitors) || 0;
      const permanent = u.billingPermanent === true || b.permanent === true;
      return `
      <article class="card user-card user-card-compact${open ? ' is-open' : ''}" data-id="${escapeHtml(u.id)}">
        <button type="button" class="user-card-toggle" data-action="toggle-billing-card" aria-expanded="${open}">
          <div class="user-card-main">
            <strong title="${escapeHtml(u.email)}">${escapeHtml(u.email)}</strong>
            <p class="meta">Status: <strong>${escapeHtml(b.status || '—')}</strong></p>
            <p class="meta">${
              permanent
                ? '· permanente'
                : b.expiresAt
                  ? `· até ${formatDate(b.expiresAt)}`
                  : '· —'
            }</p>
          </div>
          <span class="chevron" aria-hidden="true"></span>
          <div class="user-usage-summary">
            <span>Sites <strong>${sitesUsed}/${sitesMax}</strong></span>
            <span>Plano <strong>${escapeHtml(b.planId || (permanent ? 'permanente' : '—'))}</strong></span>
            <span class="status ${b.entitled ? 'ok' : 'error'}">${b.entitled ? 'liberado' : 'bloqueado'}</span>
          </div>
        </button>
        <div class="user-card-body"${open ? '' : ' hidden'}>
          <div class="user-grid billing-user-grid">
            <label class="check">
              <input type="checkbox" class="billing-active" ${u.billingActive !== false ? 'checked' : ''} />
              Cobrança ativa
            </label>
            <label class="check">
              <input type="checkbox" class="billing-permanent" ${permanent ? 'checked' : ''} />
              Ativar permanentemente
            </label>
            <label>
              Expira em
              <input type="datetime-local" class="billing-expires" value="${toLocalInput(u.billingExpiresAt)}" ${
                permanent ? 'disabled' : ''
              } />
            </label>
          </div>
          <div class="actions wrap">
            <button type="button" class="btn small" data-action="save-billing-user">Salvar</button>
            <button type="button" class="btn small" data-action="extend-30">+30 dias</button>
            <button type="button" class="btn small" data-action="extend-15">+15 dias</button>
            <button type="button" class="btn small" data-action="extend-1">+1 dia</button>
          </div>
        </div>
      </article>`;
    })
    .join('');
}

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderBillingPayments(payments) {
  if (!els.billingPaymentsList) return;
  if (!payments?.length) {
    els.billingPaymentsList.innerHTML = `<p class="empty">Nenhum pagamento ainda.</p>`;
    return;
  }
  els.billingPaymentsList.innerHTML = payments
    .map(
      (p) => `
    <article class="card payment-card">
      <strong title="${escapeHtml(p.planId || 'plano')}">${escapeHtml(p.planId || 'plano')}</strong>
      <p class="meta">R$ ${Number(p.amount).toFixed(2)} · ${escapeHtml(p.status)} · ${formatDate(p.createdAt)}</p>
      <p class="meta" title="user: ${escapeHtml(p.userId)}${
        p.mpPaymentId ? ` · MP ${escapeHtml(String(p.mpPaymentId))}` : ''
      }">user: ${escapeHtml(String(p.userId || '').slice(0, 8))}…${
        p.mpPaymentId ? ` · MP ${escapeHtml(String(p.mpPaymentId))}` : ''
      }</p>
    </article>`
    )
    .join('');
}

async function refreshBillingAdmin() {
  const data = await api('/admin/billing');
  if (els.mpWebhookUrl) {
    els.mpWebhookUrl.textContent = `${location.origin}/api/billing/webhook`;
  }
  if (els.mpAccessToken) els.mpAccessToken.value = data.raw?.mercadoPago?.accessToken || '';
  if (els.mpPublicKey) els.mpPublicKey.value = data.raw?.mercadoPago?.publicKey || '';
  if (els.mpWebhookSecret) els.mpWebhookSecret.value = data.raw?.mercadoPago?.webhookSecret || '';
  if (els.mpEnabled) els.mpEnabled.checked = data.raw?.mercadoPago?.enabled !== false;
  if (els.billingTrialDays) els.billingTrialDays.value = data.raw?.trialDays ?? 30;
  if (els.billingTrialEmails) {
    els.billingTrialEmails.value = data.raw?.trialEmailDailyLimit ?? 10;
  }
  if (els.billingTrialSites) els.billingTrialSites.value = data.raw?.trialMaxMonitors ?? 5;
  renderPlansAdmin(data.raw?.plans || data.config?.allPlans || []);
  renderBillingUsers(data.users || []);
  renderBillingPayments(data.payments || []);
}

els.btnBrowserNotify?.addEventListener('click', async () => {
  browserNotifyEnabled = !browserNotifyEnabled;
  await api('/settings', {
    method: 'PATCH',
    body: JSON.stringify({ browserNotifications: browserNotifyEnabled }),
  });
  if (browserNotifyEnabled) await enableBrowserNotifications();
  syncEmailNotifyUi(currentUser);
});

els.btnDesktopNotify?.addEventListener('click', async () => {
  desktopNotifyEnabled = !desktopNotifyEnabled;
  await api('/settings', {
    method: 'PATCH',
    body: JSON.stringify({ desktopNotifications: desktopNotifyEnabled }),
  });
  syncEmailNotifyUi(currentUser);
});

els.btnEmailNotify?.addEventListener('click', async () => {
  if (!hasPaidEmailAccess(currentUser)) {
    openEmailPlansDialog();
    return;
  }
  const enabled = currentUser?.emailNotifyStatus !== 'approved';
  try {
    const data = await api('/auth/email-notify', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
    currentUser = data.user;
    syncEmailNotifyUi(currentUser);
    if (data.message) billingFlash(data.message);
  } catch (err) {
    if (
      err.message?.includes('plano') ||
      err.message?.includes('Assine') ||
      err.message?.includes('e-mail')
    ) {
      openEmailPlansDialog();
    } else alert(err.message);
    syncEmailNotifyUi(currentUser);
  }
});

function openEmailPlansDialog() {
  if (!els.emailPlansDialog) {
    setView('billing');
    return;
  }
  if (!els.emailPlansDialog.open) els.emailPlansDialog.showModal();
}

function closeEmailPlansDialog() {
  els.emailPlansDialog?.close();
}

els.emailPlansClose?.addEventListener('click', () => closeEmailPlansDialog());
els.emailPlansGo?.addEventListener('click', () => {
  closeEmailPlansDialog();
  setView('billing');
});
els.emailPlansDialog?.addEventListener('click', (e) => {
  if (e.target === els.emailPlansDialog) closeEmailPlansDialog();
});

els.mpConfigForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/admin/billing', {
      method: 'PUT',
      body: JSON.stringify({
        mercadoPago: {
          accessToken: els.mpAccessToken?.value || '',
          publicKey: els.mpPublicKey?.value || '',
          webhookSecret: els.mpWebhookSecret?.value || '',
          enabled: Boolean(els.mpEnabled?.checked),
        },
      }),
    });
    billingAdminFlash('Configuração Mercado Pago salva.');
    await refreshBillingAdmin();
  } catch (err) {
    billingAdminFlash(err.message, true);
  }
});

els.trialConfigForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/admin/billing', {
      method: 'PUT',
      body: JSON.stringify({
        trialDays: Number(els.billingTrialDays?.value) || 0,
        trialEmailDailyLimit: Number(els.billingTrialEmails?.value) || 0,
        trialMaxMonitors: Math.max(1, Number(els.billingTrialSites?.value) || 5),
      }),
    });
    billingAdminFlash('Padrão do plano trial salvo.');
    await refreshBillingAdmin();
  } catch (err) {
    billingAdminFlash(err.message, true);
  }
});

els.reconcileForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const mpPaymentId = String(els.mpReconcileId?.value || '').trim();
  if (!mpPaymentId) {
    billingAdminFlash('Informe o ID do pagamento.', true);
    return;
  }
  try {
    const result = await api('/admin/billing/reconcile', {
      method: 'POST',
      body: JSON.stringify({ mpPaymentId }),
    });
    if (result.activated) billingAdminFlash(`Pagamento ${mpPaymentId} liberado.`);
    else if (result.already) billingAdminFlash(`Pagamento ${mpPaymentId} já estava liberado.`);
    else if (result.unmatched) {
      billingAdminFlash('Pagamento aprovado no MP, mas sem vínculo de usuário/plano.', true);
    } else billingAdminFlash(`Status MP: ${result.status || 'ok'}`);
    if (els.mpReconcileId) els.mpReconcileId.value = '';
    await refreshBillingAdmin();
    await refreshSessionUi();
  } catch (err) {
    billingAdminFlash(err.message, true);
  }
});

els.plansAdminForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const plans = collectPlansAdminFromDom();
  try {
    await api('/admin/billing', { method: 'PUT', body: JSON.stringify({ plans }) });
    billingAdminFlash('Planos atualizados.');
    await refreshBillingAdmin();
  } catch (err) {
    billingAdminFlash(err.message, true);
  }
});

els.billingUsersList?.addEventListener('click', async (e) => {
  const toggleCard = e.target.closest('[data-action="toggle-billing-card"]');
  if (toggleCard) {
    const card = toggleCard.closest('.user-card');
    const id = card?.dataset.id;
    if (!id) return;
    if (expandedBillingUserIds.has(id)) expandedBillingUserIds.delete(id);
    else expandedBillingUserIds.add(id);
    renderBillingUsers(cachedBillingUsers);
    return;
  }

  const btn = e.target.closest('[data-action]');
  if (!btn || btn.dataset.action === 'toggle-billing-card') return;
  const card = btn.closest('.user-card');
  const id = card?.dataset.id;
  if (!id) return;
  btn.disabled = true;
  try {
    if (btn.dataset.action === 'save-billing-user') {
      const billingActive = card.querySelector('.billing-active').checked;
      const billingPermanent = card.querySelector('.billing-permanent')?.checked === true;
      const local = card.querySelector('.billing-expires').value;
      const billingExpiresAt = billingPermanent ? null : local ? new Date(local).toISOString() : null;
      await api(`/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ billingActive, billingPermanent, billingExpiresAt }),
      });
      billingAdminFlash(
        billingPermanent ? 'Usuário ativado permanentemente.' : 'Assinatura do usuário atualizada.'
      );
    }
    if (btn.dataset.action === 'extend-30') {
      await api(`/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ billingDaysExtend: 30, billingPermanent: false }),
      });
    }
    if (btn.dataset.action === 'extend-15') {
      await api(`/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ billingDaysExtend: 15, billingPermanent: false }),
      });
    }
    if (btn.dataset.action === 'extend-1') {
      await api(`/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ billingDaysExtend: 1, billingPermanent: false }),
      });
    }
    await refreshBillingAdmin();
  } catch (err) {
    billingAdminFlash(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  els.btnInstall?.classList.remove('hidden');
});

els.btnInstall?.addEventListener('click', async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  els.btnInstall.classList.add('hidden');
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

els.btnLogout?.addEventListener('click', async () => {
  try {
    await api('/auth/logout', { method: 'POST', body: '{}' });
  } catch {
    /* ignore */
  }
  window.location.href = '/login.html';
});

updateNotifyUi();

(async () => {
  try {
    const me = await api('/auth/me');
    currentUser = me.user;
    if (els.userEmail && me.user?.email) {
      els.userEmail.textContent = me.user.email;
      els.userEmail.hidden = false;
    }
    if (els.navAdmin && me.user?.role === 'admin') {
      els.navAdmin.classList.remove('hidden');
    }
    if (els.navBilling && me.user?.role === 'admin') {
      els.navBilling.classList.remove('hidden');
    }
    syncEmailNotifyUi(me.user);
    if (els.quotaHint && me.quota) {
      els.quotaHint.hidden = false;
      els.quotaHint.textContent = `Sites: ${me.quota.used} de ${me.quota.maxMonitors} disponíveis.`;
    }
    if (me.user?.accessRestricted && me.user?.role !== 'admin') {
      enforceAccessGate();
      await refreshBilling().catch(console.error);
      setView('billing');
      if (els.billingFlash) {
        els.billingFlash.hidden = false;
        els.billingFlash.textContent =
          'Conta bloqueada. Escolha um plano e pague com Pix para recuperar o acesso.';
        els.billingFlash.classList.add('warn-text');
      }
      return;
    }
    connectSse();
    await refresh();
    const hash = location.hash.replace('#', '') || 'dashboard';
    const initial = hash.split('?')[0] || 'dashboard';
    setView(initial);
  } catch (err) {
    if (!String(err.message).includes('Não autenticado') && els.monitors) {
      els.monitors.innerHTML = `<p class="empty">Falha ao carregar: ${escapeHtml(err.message)}</p>`;
    }
  }
})();
