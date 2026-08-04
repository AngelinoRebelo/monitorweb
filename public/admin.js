const $ = (sel) => document.querySelector(sel);

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('Não autenticado');
  }
  if (res.status === 403) {
    window.location.href = '/';
    throw new Error('Acesso negado');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function flash(message, isError = false) {
  const el = $('#admin-flash');
  el.hidden = false;
  el.textContent = message;
  el.classList.toggle('warn-text', isError);
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(
      new Date(iso)
    );
  } catch {
    return iso;
  }
}

let cachedUsers = [];

function renderUsers(users) {
  cachedUsers = users;
  const root = $('#users-list');
  if (!users.length) {
    root.innerHTML = `<p class="empty">Nenhum usuário cadastrado.</p>`;
    return;
  }

  root.innerHTML = users
    .map((u) => {
      const pending = u.resetPending
        ? `<p class="meta warn-text">Recuperação pendente desde ${formatDate(u.resetRequestedAt)}</p>`
        : '';
      return `
      <article class="card user-card" data-id="${escapeHtml(u.id)}">
        <div class="user-head">
          <div>
            <strong>${escapeHtml(u.email)}</strong>
            <p class="meta">${u.role === 'admin' ? 'Administrador' : 'Usuário'} · desde ${formatDate(u.createdAt)}</p>
            ${pending}
          </div>
          <span class="status ${u.active ? 'ok' : 'error'}">${u.active ? 'ativa' : 'desativada'}</span>
        </div>
        <div class="user-grid">
          <label>
            Limite de sites
            <input type="number" min="0" max="1000" class="max-monitors" value="${Number(u.maxMonitors)}" />
          </label>
          <p class="meta usage">Em uso: <strong>${u.monitorCount}</strong> / ${u.maxMonitors}</p>
        </div>
        <div class="actions wrap">
          <button type="button" class="btn small" data-action="save-limit">Salvar limite</button>
          <button type="button" class="btn small" data-action="toggle">${u.active ? 'Desativar' : 'Ativar'}</button>
          <button type="button" class="btn small" data-action="password">Nova senha</button>
          <button type="button" class="btn small" data-action="reset-link">Link de recuperação</button>
          ${u.role === 'admin' ? '' : `<button type="button" class="btn small danger" data-action="delete">Excluir</button>`}
        </div>
        <p class="hint reset-link-box" hidden></p>
      </article>`;
    })
    .join('');
}

async function refresh() {
  const me = await api('/auth/me');
  if (me.user?.role !== 'admin') {
    window.location.href = '/';
    return;
  }
  const data = await api('/admin/users');
  renderUsers(data.users || []);
}

$('#users-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const card = btn.closest('.user-card');
  const id = card?.dataset.id;
  if (!id) return;
  const user = cachedUsers.find((u) => u.id === id);
  const action = btn.dataset.action;
  btn.disabled = true;
  try {
    if (action === 'save-limit') {
      const maxMonitors = Number(card.querySelector('.max-monitors').value);
      await api(`/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ maxMonitors }),
      });
      flash(`Limite de ${user.email} atualizado.`);
    }
    if (action === 'toggle') {
      await api(`/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !user.active }),
      });
      flash(`Conta ${user.email} ${user.active ? 'desativada' : 'ativada'}.`);
    }
    if (action === 'password') {
      const password = prompt(`Nova senha para ${user.email} (mín. 8 caracteres):`);
      if (!password) return;
      await api(`/admin/users/${id}/password`, {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      flash(`Senha de ${user.email} redefinida.`);
    }
    if (action === 'reset-link') {
      const data = await api(`/admin/users/${id}/reset-link`, {
        method: 'POST',
        body: '{}',
      });
      const box = card.querySelector('.reset-link-box');
      box.hidden = false;
      box.textContent = data.resetUrl;
      try {
        await navigator.clipboard.writeText(data.resetUrl);
        flash(`Link copiado para ${user.email}. Envie ao usuário.`);
      } catch {
        flash(`Link gerado para ${user.email}. Copie abaixo.`);
      }
    }
    if (action === 'delete') {
      if (!confirm(`Excluir ${user.email} e todos os monitores dele?`)) return;
      await api(`/admin/users/${id}`, { method: 'DELETE' });
      flash(`Usuário ${user.email} excluído.`);
    }
    await refresh();
  } catch (err) {
    flash(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('#btn-logout').addEventListener('click', async () => {
  try {
    await api('/auth/logout', { method: 'POST', body: '{}' });
  } catch {
    /* ignore */
  }
  window.location.href = '/login.html';
});

refresh().catch((err) => flash(err.message, true));
