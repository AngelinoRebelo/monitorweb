const $ = (sel) => document.querySelector(sel);

const els = {
  form: $('#auth-form'),
  title: $('#auth-title'),
  lead: $('#auth-lead'),
  submit: $('#auth-submit'),
  error: $('#auth-error'),
  password: $('#password'),
  tabRegister: $('#tab-register'),
  registerHint: $('#register-hint'),
  tabs: document.querySelectorAll('.auth-tab'),
};

let mode = 'login';
let registrationOpen = false;

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

function setMode(next) {
  if (next === 'register' && !registrationOpen) return;
  mode = next;
  els.tabs.forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  els.title.textContent = mode === 'login' ? 'Entrar' : 'Criar conta';
  els.lead.textContent =
    mode === 'login'
      ? 'Use seu e-mail e senha para acessar o painel.'
      : 'Crie sua conta. Seus monitores ficam separados dos de outros usuários.';
  els.submit.textContent = mode === 'login' ? 'Entrar' : 'Cadastrar';
  els.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  els.error.hidden = true;
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

els.tabs.forEach((tab) => {
  tab.addEventListener('click', () => setMode(tab.dataset.mode));
});

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.error.hidden = true;
  els.submit.disabled = true;
  const body = {
    email: $('#email').value.trim(),
    password: els.password.value,
  };
  try {
    await api(mode === 'login' ? '/auth/login' : '/auth/register', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    window.location.href = '/';
  } catch (err) {
    showError(err.message);
  } finally {
    els.submit.disabled = false;
  }
});

(async () => {
  try {
    const status = await api('/auth/status');
    if (status.authenticated) {
      window.location.href = '/';
      return;
    }
    registrationOpen = Boolean(status.registrationOpen);
    els.tabRegister.disabled = !registrationOpen;
    els.tabRegister.hidden = !registrationOpen;
    if (els.registerHint) els.registerHint.hidden = !registrationOpen;
    if (registrationOpen && !status.hasUsers) setMode('register');
  } catch (err) {
    showError(err.message);
  }
})();
