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
    const detail =
      body?.message ||
      body?.error ||
      (Array.isArray(body?.code) ? body.code.join(', ') : body?.code) ||
      JSON.stringify(body) ||
      `Brevo HTTP ${res.status}`;
    throw new Error(detail);
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

export async function sendChangeNotificationEmail({ to, monitorName, summary, url, appUrl }) {
  const subject = `MonitorWeb — mudança em ${monitorName}`;
  const text = [
    `Detectamos uma alteração no monitor "${monitorName}".`,
    '',
    summary || 'Conteúdo alterado',
    '',
    url ? `Página: ${url}` : '',
    appUrl ? `Painel: ${appUrl}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const html = `
  <div style="font-family:Arial,sans-serif;line-height:1.5;color:#123126;max-width:560px">
    <h2 style="margin:0 0 12px">Mudança detectada</h2>
    <p>O monitor <strong>${monitorName}</strong> registrou uma alteração.</p>
    <p style="background:#f4f1ea;padding:12px 14px;border-radius:10px">${summary || 'Conteúdo alterado'}</p>
    ${url ? `<p><a href="${url}">Abrir página monitorada</a></p>` : ''}
    ${appUrl ? `<p><a href="${appUrl}">Abrir Dashboard</a></p>` : ''}
  </div>`;

  return sendMail({ to, subject, html, text });
}

export async function sendPaymentReceiptEmail({
  to,
  planLabel,
  planDays,
  planPrice,
  maxMonitors,
  features,
  expiresAt,
  paymentId,
  mpPaymentId,
  paidAt,
  appUrl,
}) {
  const subject = `MonitorWeb — comprovante de pagamento (${planLabel || 'plano'})`;
  const paidLabel = paidAt ? new Date(paidAt).toLocaleString('pt-BR') : new Date().toLocaleString('pt-BR');
  const expLabel = expiresAt ? new Date(expiresAt).toLocaleString('pt-BR') : 'conforme plano';
  const priceLabel = `R$ ${Number(planPrice || 0).toFixed(2).replace('.', ',')}`;
  const featureLines =
    Array.isArray(features) && features.length
      ? features
      : ['Alertas por e-mail', `Até ${maxMonitors || 100} sites para monitoramento`];

  const text = [
    'Comprovante de pagamento — MonitorWeb',
    '',
    `Plano: ${planLabel || '—'}`,
    `Valor: ${priceLabel}`,
    `Duração: ${planDays || '—'} dia(s)`,
    `Limite de sites: ${maxMonitors || 100}`,
    `Pago em: ${paidLabel}`,
    `Válido até: ${expLabel}`,
    mpPaymentId ? `ID Mercado Pago: ${mpPaymentId}` : '',
    paymentId ? `Referência: ${paymentId}` : '',
    '',
    'Itens inclusos:',
    ...featureLines.map((f) => `- ${f}`),
    '',
    appUrl ? `Painel: ${appUrl}` : '',
    '',
    'Este é um comprovante automático do MonitorWeb (não substitui documento fiscal oficial do Mercado Pago).',
  ]
    .filter(Boolean)
    .join('\n');

  const rows = [
    ['Plano', planLabel || '—'],
    ['Valor pago', priceLabel],
    ['Duração', `${planDays || '—'} dia(s)`],
    ['Limite de sites', String(maxMonitors || 100)],
    ['Data do pagamento', paidLabel],
    ['Válido até', expLabel],
    mpPaymentId ? ['ID Mercado Pago', String(mpPaymentId)] : null,
    paymentId ? ['Referência interna', String(paymentId)] : null,
  ].filter(Boolean);

  const html = `
  <div style="font-family:Arial,sans-serif;line-height:1.5;color:#123126;max-width:560px">
    <h2 style="margin:0 0 8px">Comprovante de pagamento</h2>
    <p style="margin:0 0 16px;color:#4a5c54">MonitorWeb — nota do plano adquirido</p>
    <table style="width:100%;border-collapse:collapse;margin:0 0 16px">
      ${rows
        .map(
          ([k, v]) => `
        <tr>
          <td style="padding:8px 10px;border:1px solid #d7e0db;background:#f7faf8;width:42%"><strong>${k}</strong></td>
          <td style="padding:8px 10px;border:1px solid #d7e0db">${v}</td>
        </tr>`
        )
        .join('')}
    </table>
    <p style="margin:0 0 8px"><strong>Itens inclusos</strong></p>
    <ul style="margin:0 0 16px;padding-left:18px">
      ${featureLines.map((f) => `<li>${f}</li>`).join('')}
    </ul>
    ${appUrl ? `<p><a href="${appUrl}">Abrir painel MonitorWeb</a></p>` : ''}
    <p style="font-size:12px;color:#6b7a73;margin-top:18px">
      Comprovante automático do MonitorWeb. O comprovante oficial do meio de pagamento permanece no Mercado Pago.
    </p>
  </div>`;

  return sendMail({ to, subject, html, text });
}

function fmtBr(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('pt-BR');
  } catch {
    return String(iso);
  }
}

export async function sendWelcomeEmail({ to, trialDays, trialSites, trialEndsAt, appUrl }) {
  const subject = 'Bem-vindo ao MonitorWeb';
  const exp = fmtBr(trialEndsAt);
  const text = [
    'Bem-vindo ao MonitorWeb!',
    '',
    'Sua conta foi criada com sucesso.',
    `Você tem ${trialDays || 0} dia(s) de trial com até ${trialSites || 0} site(s).`,
    trialEndsAt ? `O trial vai até ${exp}.` : '',
    '',
    'No trial você pode monitorar sites com alertas no navegador. Alertas por e-mail ficam nos planos pagos.',
    '',
    appUrl ? `Acesse o painel: ${appUrl}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const html = `
  <div style="font-family:Arial,sans-serif;line-height:1.5;color:#123126;max-width:560px">
    <h2 style="margin:0 0 12px">Bem-vindo ao MonitorWeb</h2>
    <p>Sua conta foi criada com sucesso.</p>
    <p style="background:#f7faf8;padding:12px 14px;border-radius:10px;border:1px solid #d7e0db">
      Trial de <strong>${trialDays || 0} dia(s)</strong> com até <strong>${trialSites || 0} site(s)</strong>.<br/>
      ${trialEndsAt ? `Válido até <strong>${exp}</strong>.` : ''}
    </p>
    <p>No trial você monitora sites com alertas no navegador. Para receber alertas por e-mail e ampliar o limite, escolha um plano.</p>
    ${
      appUrl
        ? `<p style="margin:24px 0"><a href="${appUrl}" style="background:#d4a24c;color:#1a1408;padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:700;display:inline-block">Abrir painel</a></p>`
        : ''
    }
  </div>`;

  return sendMail({ to, subject, html, text });
}

export async function sendAdminNewUserEmail({
  to,
  userEmail,
  userId,
  createdAt,
  trialEndsAt,
  maxMonitors,
  emailDailyLimit,
  role,
  appUrl,
}) {
  const subject = `MonitorWeb — nova conta: ${userEmail}`;
  const text = [
    'Nova conta criada no MonitorWeb',
    '',
    `E-mail: ${userEmail}`,
    `ID: ${userId}`,
    `Perfil: ${role || 'user'}`,
    `Criada em: ${fmtBr(createdAt)}`,
    `Trial até: ${fmtBr(trialEndsAt)}`,
    `Sites iniciais: ${maxMonitors}`,
    `Limite e-mail/dia: ${emailDailyLimit}`,
    appUrl ? `Painel: ${appUrl}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const rows = [
    ['E-mail', userEmail || '—'],
    ['ID', userId || '—'],
    ['Perfil', role || 'user'],
    ['Criada em', fmtBr(createdAt)],
    ['Trial até', fmtBr(trialEndsAt)],
    ['Sites iniciais', String(maxMonitors ?? '—')],
    ['Limite e-mail/dia', String(emailDailyLimit ?? '—')],
  ];

  const html = `
  <div style="font-family:Arial,sans-serif;line-height:1.5;color:#123126;max-width:560px">
    <h2 style="margin:0 0 8px">Nova conta criada</h2>
    <p style="margin:0 0 16px;color:#4a5c54">Aviso automático para o administrador</p>
    <table style="width:100%;border-collapse:collapse;margin:0 0 16px">
      ${rows
        .map(
          ([k, v]) => `
        <tr>
          <td style="padding:8px 10px;border:1px solid #d7e0db;background:#f7faf8;width:38%"><strong>${k}</strong></td>
          <td style="padding:8px 10px;border:1px solid #d7e0db">${v}</td>
        </tr>`
        )
        .join('')}
    </table>
    ${appUrl ? `<p><a href="${appUrl}/#admin">Abrir Admin</a></p>` : ''}
  </div>`;

  return sendMail({ to, subject, html, text });
}

export async function sendPlanExpiryWarningEmail({
  to,
  daysLeft,
  planKind,
  expiresAt,
  graceDays,
  appUrl,
}) {
  const kindLabel = planKind === 'paid' ? 'plano pago' : 'período trial';
  const subject = `MonitorWeb — seu ${kindLabel} expira em ${daysLeft} dia(s)`;
  const exp = fmtBr(expiresAt);
  const graceNote =
    planKind === 'paid' && graceDays > 0
      ? `Após o vencimento você entra automaticamente em modo trial por ${graceDays} dia(s), com o limite de sites do trial. Renove antes para manter o plano pago sem interrupção.`
      : 'Renove ou escolha um plano para continuar com mais sites e alertas por e-mail.';

  const text = [
    `Atenção: seu ${kindLabel} no MonitorWeb expira em ${daysLeft} dia(s).`,
    '',
    `Data de vencimento: ${exp}`,
    '',
    graceNote,
    '',
    appUrl ? `Escolher plano: ${appUrl}/#billing` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const html = `
  <div style="font-family:Arial,sans-serif;line-height:1.5;color:#123126;max-width:560px">
    <h2 style="margin:0 0 12px">Aviso de vencimento</h2>
    <p>Seu <strong>${kindLabel}</strong> expira em <strong>${daysLeft} dia(s)</strong>.</p>
    <p style="background:#fff6e8;padding:12px 14px;border-radius:10px;border:1px solid #ecd7a8">
      Vencimento: <strong>${exp}</strong>
    </p>
    <p>${graceNote}</p>
    ${
      appUrl
        ? `<p style="margin:24px 0"><a href="${appUrl}/#billing" style="background:#d4a24c;color:#1a1408;padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:700;display:inline-block">Ver planos</a></p>`
        : ''
    }
  </div>`;

  return sendMail({ to, subject, html, text });
}

export async function sendPostPaidGraceEmail({ to, graceDays, graceEndsAt, appUrl }) {
  const subject = 'MonitorWeb — plano pago encerrado; trial de cortesia iniciado';
  const exp = fmtBr(graceEndsAt);
  const text = [
    'Seu plano pago no MonitorWeb encerrou.',
    '',
    `Você entrou em modo trial por ${graceDays} dia(s), válido até ${exp}.`,
    'Nesse período vale o limite de sites do trial. Alertas por e-mail ficam nos planos pagos.',
    '',
    appUrl ? `Renovar: ${appUrl}/#billing` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const html = `
  <div style="font-family:Arial,sans-serif;line-height:1.5;color:#123126;max-width:560px">
    <h2 style="margin:0 0 12px">Plano pago encerrado</h2>
    <p>Você entrou em <strong>modo trial por ${graceDays} dia(s)</strong>.</p>
    <p style="background:#f7faf8;padding:12px 14px;border-radius:10px;border:1px solid #d7e0db">
      Trial de cortesia até <strong>${exp}</strong>.
    </p>
    <p>Nesse período vale o limite de sites do trial. Para voltar ao plano pago e aos alertas por e-mail, escolha um plano.</p>
    ${
      appUrl
        ? `<p style="margin:24px 0"><a href="${appUrl}/#billing" style="background:#d4a24c;color:#1a1408;padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:700;display:inline-block">Ver planos</a></p>`
        : ''
    }
  </div>`;

  return sendMail({ to, subject, html, text });
}
