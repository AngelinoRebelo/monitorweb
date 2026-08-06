import { applyLogoChoice } from './brand.js';

applyLogoChoice();

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(window.location.search);
const token = params.get('token') || '';

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

function showError(message) {
  const el = $('#reset-error');
  el.textContent = message;
  el.hidden = false;
}

if (!token) {
  showError('Link inválido. Solicite uma nova recuperação.');
  $('#reset-form').hidden = true;
} else {
  api(`/auth/reset/validate?token=${encodeURIComponent(token)}`)
    .then((data) => {
      $('#reset-lead').textContent = `Defina uma nova senha para ${data.email}.`;
    })
    .catch((err) => {
      showError(err.message);
      $('#reset-form').hidden = true;
    });
}

$('#reset-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('#password').value;
  const password2 = $('#password2').value;
  if (password !== password2) {
    showError('As senhas não coincidem.');
    return;
  }
  $('#reset-submit').disabled = true;
  try {
    await api('/auth/reset', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    });
    window.location.href = '/login.html?reset=1';
  } catch (err) {
    showError(err.message);
  } finally {
    $('#reset-submit').disabled = false;
  }
});
