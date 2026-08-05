const $ = (sel) => document.querySelector(sel);

const els = {
  form: $('#auth-form'),
  title: $('#auth-title'),
  lead: $('#auth-lead'),
  submit: $('#auth-submit'),
  error: $('#auth-error'),
  ok: $('#auth-ok'),
  paywall: $('#auth-paywall'),
  paywallMsg: $('#auth-paywall-msg'),
  paywallBtn: $('#auth-paywall-btn'),
  password: $('#password'),
  passwordField: $('#password-field'),
  tabRegister: $('#tab-register'),
  registerHint: $('#register-hint'),
  forgotHint: $('#forgot-hint'),
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
  if (!res.ok) {
    const err = new Error(data.error || `Erro ${res.status}`);
    err.status = res.status;
    err.code = data.code;
    err.data = data;
    throw err;
  }
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

  const titles = {
    login: 'Entrar',
    register: 'Criar conta',
    forgot: 'Recuperar senha',
  };
  const leads = {
    login: 'Use seu e-mail e senha para acessar o painel.',
    register: 'Crie sua conta. Seus monitores ficam separados dos de outros usuários.',
    forgot: 'Informe o e-mail da conta. Enviaremos um link para redefinir a senha.',
  };
  const submits = {
    login: 'Entrar',
    register: 'Cadastrar',
    forgot: 'Solicitar recuperação',
  };

  els.title.textContent = titles[mode];
  els.lead.textContent = leads[mode];
  els.submit.textContent = submits[mode];
  els.passwordField.hidden = mode === 'forgot';
  els.password.required = mode !== 'forgot';
  els.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  els.registerHint.hidden = mode !== 'register' || !registrationOpen;
  els.forgotHint.hidden = mode !== 'forgot';
  els.error.hidden = true;
  els.ok.hidden = true;
  if (els.paywall) els.paywall.hidden = true;
  if (els.submit) els.submit.hidden = false;
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
  els.ok.hidden = true;
  if (els.paywall) els.paywall.hidden = true;
  if (els.submit) els.submit.hidden = false;
}

function showOk(message) {
  els.ok.textContent = message;
  els.ok.hidden = false;
  els.error.hidden = true;
  if (els.paywall) els.paywall.hidden = true;
}

function showPaywall(message) {
  if (els.paywallMsg) {
    els.paywallMsg.textContent =
      message ||
      'Sua conta está bloqueada. É necessário pagar um plano para acessar novamente.';
  }
  if (els.paywall) els.paywall.hidden = false;
  els.error.hidden = true;
  els.ok.hidden = true;
  if (els.submit) els.submit.hidden = true;
}

els.tabs.forEach((tab) => {
  tab.addEventListener('click', () => setMode(tab.dataset.mode));
});

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.error.hidden = true;
  els.ok.hidden = true;
  if (els.paywall) els.paywall.hidden = true;
  els.submit.disabled = true;
  const email = $('#email').value.trim();
  const password = els.password.value;
  try {
    if (mode === 'forgot') {
      const data = await api('/auth/forgot', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      showOk(data.message || 'Pedido registrado.');
      return;
    }
    await api(mode === 'login' ? '/auth/login' : '/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    window.location.href = '/';
  } catch (err) {
    if (err.code === 'PAYMENT_REQUIRED' || err.status === 402) {
      // Session cookie was set — button opens billing area.
      showPaywall(err.message);
      return;
    }
    showError(err.message);
  } finally {
    els.submit.disabled = false;
  }
});

(async () => {
  try {
    if (new URLSearchParams(location.search).get('reset') === '1') {
      showOk('Senha atualizada. Entre com a nova senha.');
    }
    const status = await api('/auth/status');
    if (status.authenticated) {
      if (status.user?.accessRestricted) {
        window.location.href = '/#billing';
        return;
      }
      window.location.href = '/';
    }
    registrationOpen = Boolean(status.registrationOpen);
    if (els.tabRegister) {
      els.tabRegister.disabled = !registrationOpen;
      els.tabRegister.hidden = !registrationOpen;
    }
  } catch {
    /* ignore */
  }
})();
