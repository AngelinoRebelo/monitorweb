/**
 * Transactional email via HTTPS APIs (Railway Hobby blocks outbound SMTP).
 * Configure one of:
 *   RESEND_API_KEY + MAIL_FROM
 *   BREVO_API_KEY + MAIL_FROM
 * Optional:
 *   APP_BASE_URL=https://monitorweb-production.up.railway.app
 */

import { fetch as undiciFetch } from 'undici';

function mailFrom() {
  return process.env.MAIL_FROM || process.env.EMAIL_FROM || '';
}

export function isMailConfigured() {
  return Boolean(
    (process.env.RESEND_API_KEY || process.env.BREVO_API_KEY) && mailFrom()
  );
}

export function mailProvider() {
  if (process.env.RESEND_API_KEY && mailFrom()) return 'resend';
  if (process.env.BREVO_API_KEY && mailFrom()) return 'brevo';
  return null;
}

async function sendWithResend({ to, subject, html, text }) {
  const res = await undiciFetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: mailFrom(),
      to: [to],
      subject,
      html,
      text,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.message || body?.error || `Resend HTTP ${res.status}`);
  }
  return { provider: 'resend', id: body.id || null };
}

async function sendWithBrevo({ to, subject, html, text }) {
  const from = mailFrom();
  const match = from.match(/^(.*)<([^>]+)>$/);
  const sender = match
    ? { name: match[1].trim().replace(/^"|"$/g, '') || 'MonitorWeb', email: match[2].trim() }
    : { name: 'MonitorWeb', email: from };

  const res = await undiciFetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender,
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.message || JSON.stringify(body) || `Brevo HTTP ${res.status}`);
  }
  return { provider: 'brevo', id: body.messageId || null };
}

export async function sendMail({ to, subject, html, text }) {
  if (!to) throw new Error('Destinatário ausente');
  if (process.env.RESEND_API_KEY && mailFrom()) {
    return sendWithResend({ to, subject, html, text });
  }
  if (process.env.BREVO_API_KEY && mailFrom()) {
    return sendWithBrevo({ to, subject, html, text });
  }
  throw new Error(
    'E-mail não configurado. Defina RESEND_API_KEY (ou BREVO_API_KEY) e MAIL_FROM no Railway.'
  );
}

export function appBaseUrl(req) {
  const envUrl = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  if (envUrl) return envUrl;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  if (req) {
    return `${req.protocol}://${req.get('host')}`;
  }
  return 'https://monitorweb-production.up.railway.app';
}

export async function sendPasswordResetEmail({ to, resetUrl, expiresAt }) {
  const subject = 'MonitorWeb — redefinir sua senha';
  const expLabel = expiresAt
    ? new Date(expiresAt).toLocaleString('pt-BR')
    : 'em breve';
  const text = [
    'Você pediu para redefinir a senha do MonitorWeb.',
    '',
    `Abra este link para criar uma nova senha:`,
    resetUrl,
    '',
    `Este link expira em: ${expLabel}`,
    '',
    'Se você não pediu isso, ignore este e-mail.',
  ].join('\n');

  const html = `
  <div style="font-family:Arial,sans-serif;line-height:1.5;color:#123126;max-width:560px">
    <h2 style="margin:0 0 12px">Redefinir senha</h2>
    <p>Você pediu para redefinir a senha do <strong>MonitorWeb</strong>.</p>
    <p style="margin:24px 0">
      <a href="${resetUrl}" style="background:#d4a24c;color:#1a1408;padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:700;display:inline-block">
        Criar nova senha
      </a>
    </p>
    <p style="font-size:13px;color:#556">Ou copie e cole no navegador:<br/><a href="${resetUrl}">${resetUrl}</a></p>
    <p style="font-size:13px;color:#556">Este link expira em: ${expLabel}</p>
    <p style="font-size:13px;color:#556">Se você não pediu isso, ignore este e-mail.</p>
  </div>`;

  return sendMail({ to, subject, html, text });
}
