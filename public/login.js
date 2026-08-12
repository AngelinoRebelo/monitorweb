const $ = (sel) => document.querySelector(sel);

const els = {
  form: $('#auth-form'),
  card: $('#auth-card'),
  panel: $('#auth-panel'),
  prompt: $('#auth-prompt'),
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
  featureChips: document.querySelectorAll('[data-feature]'),
  featurePanel: $('#feature-panel'),
  featureTitle: $('#feature-panel-title'),
  featureCopy: $('#feature-panel-copy'),
  radarStage: $('.radar-stage'),
  radarStatus: $('#radar-status-text'),
};

const FEATURES = {
  watch: {
    title: 'Vigilância 24/7',
    copy:
      'O MonitorWeb verifica suas URLs no ritmo que você definir e registra cada alteração com histórico legível — inclusive páginas dinâmicas e fontes SEI.',
    status: 'monitorando em tempo real',
  },
  region: {
    title: 'Área exata da página',
    copy:
      'Abra a prévia, clique na região que importa e monitore só aquele trecho. Menos ruído, alertas mais precisos.',
    status: 'mira ativa na região selecionada',
  },
  alerts: {
    title: 'Alertas multi-canal',
    copy:
      'Receba avisos no navegador/PWA, no sistema local e por e-mail nos planos pagos — com a marca MonitorWeb em cada mensagem.',
    status: 'canais de alerta sincronizados',
  },
  plans: {
    title: 'Planos com Pix',
    copy:
      'Comece no trial, evolua quando precisar e libere mais sites e e-mail com pagamento Pix em minutos.',
    status: 'ativação imediata via Pix',
  },
};

const FEATURE_ORDER = ['watch', 'region', 'alerts', 'plans'];
let activeFeature = 'watch';
let featureTimer = null;
let featurePaused = false;

function setFeature(id, { fromUser = false } = {}) {
  if (!FEATURES[id]) return;
  activeFeature = id;
  if (fromUser) {
    featurePaused = true;
    restartFeatureRotation(9000);
  }

  els.featureChips.forEach((chip) => {
    const on = chip.dataset.feature === id;
    chip.classList.toggle('is-active', on);
    chip.setAttribute('aria-selected', on ? 'true' : 'false');
  });

  if (els.radarStage) els.radarStage.dataset.featureVisual = id;
  if (els.radarStatus) els.radarStatus.textContent = FEATURES[id].status;

  if (els.featurePanel) {
    els.featurePanel.classList.remove('is-switching');
    void els.featurePanel.offsetWidth;
    els.featurePanel.classList.add('is-switching');
  }
  if (els.featureTitle) els.featureTitle.textContent = FEATURES[id].title;
  if (els.featureCopy) els.featureCopy.textContent = FEATURES[id].copy;
}

function restartFeatureRotation(delayMs = 5200) {
  clearInterval(featureTimer);
  featureTimer = setInterval(() => {
    if (featurePaused) {
      featurePaused = false;
      return;
    }
    if (document.hidden) return;
    const idx = FEATURE_ORDER.indexOf(activeFeature);
    const next = FEATURE_ORDER[(idx + 1) % FEATURE_ORDER.length];
    setFeature(next);
  }, delayMs);
}

els.featureChips.forEach((chip) => {
  chip.addEventListener('click', () => setFeature(chip.dataset.feature, { fromUser: true }));
  chip.addEventListener('mouseenter', () => {
    if (window.matchMedia('(hover: hover)').matches) {
      setFeature(chip.dataset.feature, { fromUser: true });
    }
  });
});

if (els.featureChips.length) {
  setFeature('watch');
  restartFeatureRotation();
}

// Subtle pointer parallax on showcase atmosphere.
const stage = $('.auth-stage');
if (stage && window.matchMedia('(pointer: fine)').matches) {
  stage.addEventListener('pointermove', (e) => {
    const rect = stage.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    document.documentElement.style.setProperty('--auth-px', `${(x * 12).toFixed(2)}px`);
    document.documentElement.style.setProperty('--auth-py', `${(y * 10).toFixed(2)}px`);
  });
}

let mode = null;
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

function hidePaywall() {
  if (els.paywall) {
    els.paywall.hidden = true;
    els.paywall.setAttribute('hidden', '');
  }
  if (els.submit) {
    els.submit.hidden = false;
    els.submit.removeAttribute('hidden');
    els.submit.disabled = false;
  }
}

function showPaywall(message) {
  if (els.paywallMsg) {
    els.paywallMsg.textContent =
      message ||
      'Sua conta está bloqueada. É necessário pagar um plano para acessar novamente.';
  }
  if (els.paywall) {
    els.paywall.hidden = false;
    els.paywall.removeAttribute('hidden');
  }
  els.error.hidden = true;
  els.ok.hidden = true;
  if (els.submit) {
    els.submit.hidden = true;
    els.submit.setAttribute('hidden', '');
  }
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

  if (els.card) els.card.classList.remove('is-collapsed');
  if (els.panel) {
    els.panel.hidden = false;
    els.panel.removeAttribute('hidden');
  }
  if (els.prompt) els.prompt.hidden = true;

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
  hidePaywall();
  // Focus first field after expand
  requestAnimationFrame(() => {
    const email = $('#email');
    email?.focus?.();
  });
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
  els.ok.hidden = true;
  hidePaywall();
}

function showOk(message) {
  els.ok.textContent = message;
  els.ok.hidden = false;
  els.error.hidden = true;
  hidePaywall();
}

els.tabs.forEach((tab) => {
  tab.addEventListener('click', () => setMode(tab.dataset.mode));
});

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!mode) {
    setMode('login');
  }
  els.error.hidden = true;
  els.ok.hidden = true;
  hidePaywall();
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
    if (mode === 'login' && (err.code === 'PAYMENT_REQUIRED' || err.status === 402)) {
      // Só após tentativa de login com conta bloqueada.
      showPaywall(err.message);
      return;
    }
    showError(err.message);
  } finally {
    if (els.submit && els.paywall?.hidden !== false) {
      els.submit.disabled = false;
    } else if (els.submit && els.paywall && !els.paywall.hidden) {
      els.submit.disabled = false;
      els.submit.hidden = true;
    } else {
      els.submit.disabled = false;
    }
  }
});

(async () => {
  // Ao atualizar a página, o aviso de pagamento nunca deve aparecer sozinho.
  hidePaywall();
  try {
    if (new URLSearchParams(location.search).get('reset') === '1') {
      setMode('login');
      showOk('Senha atualizada. Entre com a nova senha.');
    }
    const status = await api('/auth/status');
    if (status.authenticated) {
      if (status.user?.accessRestricted) {
        // Sessão residual de tentativa anterior: limpa e mantém login limpo.
        await api('/auth/logout', { method: 'POST' }).catch(() => {});
        hidePaywall();
      } else {
        window.location.href = '/';
        return;
      }
    }
    registrationOpen = Boolean(status.registrationOpen);
    if (els.tabRegister) {
      els.tabRegister.disabled = !registrationOpen;
      els.tabRegister.hidden = !registrationOpen;
    }
  } catch {
    hidePaywall();
  }
})();
