import fs from 'node:fs';
import path from 'node:path';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { DATA_DIR } from './db.js';
import { appBaseUrl } from './mail.js';

const CONFIG_FILE = path.join(DATA_DIR, 'billing-config.json');
const PAYMENTS_FILE = path.join(DATA_DIR, 'billing-payments.json');

const DEFAULT_PLANS = [
  {
    id: 'month',
    label: '1 mês',
    days: 30,
    price: 30,
    maxMonitors: 100,
    active: true,
    features: ['Alertas por e-mail', 'Até 100 sites para monitoramento'],
  },
  {
    id: 'biweek',
    label: '15 dias',
    days: 15,
    price: 20,
    maxMonitors: 100,
    active: true,
    features: ['Alertas por e-mail', 'Até 100 sites para monitoramento'],
  },
  {
    id: 'day',
    label: '1 dia',
    days: 1,
    price: 10,
    maxMonitors: 100,
    active: true,
    features: ['Alertas por e-mail', 'Até 100 sites para monitoramento'],
  },
];

export const TRIAL_MAX_MONITORS = 5;
export const PAID_DEFAULT_MAX_MONITORS = 100;
export const TRIAL_EMAIL_DAILY_LIMIT = 10;
/** After a paid plan expires, user gets this many days of trial grace. */
export const PAID_GRACE_TRIAL_DAYS = 3;

function normalizePlan(p = {}) {
  const maxMonitors = Math.max(
    1,
    Math.min(1000, Number(p.maxMonitors) || PAID_DEFAULT_MAX_MONITORS)
  );
  const features = Array.isArray(p.features)
    ? p.features
        .map((f) =>
          String(f)
            .trim()
            .replace(/^Notifica[^\s]*\s+por e-mail$/i, 'Alertas por e-mail')
        )
        .filter(Boolean)
        .slice(0, 8)
    : [];
  const defaults = [
    'Alertas por e-mail',
    `Até ${maxMonitors} sites para monitoramento`,
  ];
  return {
    id: String(p.id || randomUUID()).slice(0, 40),
    label: String(p.label || 'Plano').slice(0, 80),
    days: Math.max(1, Number(p.days) || 1),
    price: Math.max(0, Number(p.price) || 0),
    maxMonitors,
    active: p.active !== false,
    features: features.length ? features : defaults,
  };
}

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  ensureDir();
  if (!fs.existsSync(file)) return fallback;
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function defaultConfig() {
  return {
    trialDays: 30,
    trialMaxMonitors: TRIAL_MAX_MONITORS,
    trialEmailDailyLimit: TRIAL_EMAIL_DAILY_LIMIT,
    plans: DEFAULT_PLANS.map((p) => normalizePlan(p)),
    mercadoPago: {
      accessToken: '',
      publicKey: '',
      webhookSecret: '',
      enabled: false,
    },
  };
}

export function getBillingConfig() {
  const cfg = readJson(CONFIG_FILE, defaultConfig());
  const envToken = process.env.MP_ACCESS_TOKEN || process.env.MERCADOPAGO_ACCESS_TOKEN || '';
  const envPublic = process.env.MP_PUBLIC_KEY || process.env.MERCADOPAGO_PUBLIC_KEY || '';
  const envSecret = process.env.MP_WEBHOOK_SECRET || process.env.MERCADOPAGO_WEBHOOK_SECRET || '';
  const mp = {
    accessToken: cfg.mercadoPago?.accessToken || envToken || '',
    publicKey: cfg.mercadoPago?.publicKey || envPublic || '',
    webhookSecret: cfg.mercadoPago?.webhookSecret || envSecret || '',
    enabled: Boolean(cfg.mercadoPago?.enabled),
  };
  if (!cfg.mercadoPago?.enabled && mp.accessToken) mp.enabled = true;
  const plans = (Array.isArray(cfg.plans) && cfg.plans.length ? cfg.plans : DEFAULT_PLANS).map(
    normalizePlan
  );
  return {
    trialDays: Number(cfg.trialDays) > 0 ? Number(cfg.trialDays) : 30,
    trialMaxMonitors: Math.max(
      1,
      Math.min(1000, Number(cfg.trialMaxMonitors) || TRIAL_MAX_MONITORS)
    ),
    trialEmailDailyLimit: Math.max(
      0,
      Math.min(500, Number(cfg.trialEmailDailyLimit) ?? TRIAL_EMAIL_DAILY_LIMIT)
    ),
    plans,
    mercadoPago: mp,
  };
}

export function saveBillingConfig(patch = {}) {
  const current = getBillingConfig();
  const next = {
    trialDays:
      patch.trialDays != null ? Math.max(0, Number(patch.trialDays) || 0) : current.trialDays,
    trialMaxMonitors:
      patch.trialMaxMonitors != null
        ? Math.max(1, Math.min(1000, Number(patch.trialMaxMonitors) || TRIAL_MAX_MONITORS))
        : current.trialMaxMonitors,
    trialEmailDailyLimit:
      patch.trialEmailDailyLimit != null
        ? Math.max(0, Math.min(500, Number(patch.trialEmailDailyLimit) || 0))
        : current.trialEmailDailyLimit,
    plans: Array.isArray(patch.plans)
      ? patch.plans.map((p) => normalizePlan(p))
      : current.plans,
    mercadoPago: {
      accessToken:
        patch.mercadoPago?.accessToken != null
          ? String(patch.mercadoPago.accessToken).trim()
          : current.mercadoPago.accessToken,
      publicKey:
        patch.mercadoPago?.publicKey != null
          ? String(patch.mercadoPago.publicKey).trim()
          : current.mercadoPago.publicKey,
      webhookSecret:
        patch.mercadoPago?.webhookSecret != null
          ? String(patch.mercadoPago.webhookSecret).trim()
          : current.mercadoPago.webhookSecret,
      enabled:
        patch.mercadoPago?.enabled != null
          ? Boolean(patch.mercadoPago.enabled)
          : current.mercadoPago.enabled,
    },
  };
  writeJson(CONFIG_FILE, next);
  return publicBillingConfig(next);
}

export function publicBillingConfig(cfg = getBillingConfig()) {
  const mp = cfg.mercadoPago || {};
  return {
    trialDays: cfg.trialDays,
    trialMaxMonitors: cfg.trialMaxMonitors ?? TRIAL_MAX_MONITORS,
    trialEmailDailyLimit: cfg.trialEmailDailyLimit ?? TRIAL_EMAIL_DAILY_LIMIT,
    plans: (cfg.plans || []).filter((p) => p.active !== false),
    allPlans: cfg.plans || [],
    mercadoPago: {
      enabled: Boolean(mp.enabled && mp.accessToken),
      configured: Boolean(mp.accessToken),
      publicKey: mp.publicKey || '',
      hasAccessToken: Boolean(mp.accessToken),
      hasWebhookSecret: Boolean(mp.webhookSecret),
    },
  };
}

function readPayments() {
  ensureDir();
  if (!fs.existsSync(PAYMENTS_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(PAYMENTS_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writePayments(list) {
  writeJson(PAYMENTS_FILE, list);
}

export function listPayments({ userId, limit = 100 } = {}) {
  let list = readPayments().slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (userId) list = list.filter((p) => p.userId === userId);
  return list.slice(0, limit);
}

function addDaysIso(fromIso, days) {
  const base = fromIso ? Date.parse(fromIso) : Date.now();
  const start = Number.isFinite(base) ? base : Date.now();
  return new Date(start + Math.max(0, Number(days) || 0) * 24 * 60 * 60 * 1000).toISOString();
}

export function trialEndsAtFor(createdAt, trialDays = getBillingConfig().trialDays) {
  return addDaysIso(createdAt || new Date().toISOString(), trialDays);
}

/** Effective site quota based on trial vs paid plan. */
export function getEffectiveMonitorLimit(user) {
  if (!user) return 0;
  if (user.role === 'admin') {
    return user.maxMonitors == null ? PAID_DEFAULT_MAX_MONITORS : Math.max(0, Number(user.maxMonitors));
  }
  const cfg = getBillingConfig();
  const trialMax = cfg.trialMaxMonitors ?? TRIAL_MAX_MONITORS;
  const state = getBillingState(user);
  if (state.source === 'paid' || state.source === 'permanent' || (state.status === 'active' && state.source !== 'trial')) {
    const plan = (cfg.plans || []).find((p) => p.id === (state.planId || user.billingPlanId));
    const fromPlan = plan?.maxMonitors || PAID_DEFAULT_MAX_MONITORS;
    const stored = user.maxMonitors == null ? fromPlan : Number(user.maxMonitors);
    return Math.max(fromPlan, stored, 0);
  }
  if (state.status === 'trial' || state.source === 'trial') {
    return Math.min(Number(user.maxMonitors) || trialMax, trialMax);
  }
  // expired / inactive: keep paid quota if they had one, else trial cap
  if (user.billingPlanId && user.maxMonitors != null) {
    return Math.max(0, Number(user.maxMonitors));
  }
  return trialMax;
}

/** Effective daily e-mail alert quota (trial uses Cobranças defaults). */
export function getEffectiveEmailDailyLimit(user) {
  if (!user) return 0;
  const stored =
    user.emailNotifyDailyLimit == null || Number.isNaN(Number(user.emailNotifyDailyLimit))
      ? null
      : Math.max(0, Number(user.emailNotifyDailyLimit));
  if (user.role === 'admin') {
    return stored ?? TRIAL_EMAIL_DAILY_LIMIT;
  }
  const state = getBillingState(user);
  // Admin-liberated accounts keep the limit set on the user (not trial cap).
  if (user.emailNotifyAllowed === true && !hasPaidEmailPlan(user) && stored != null) {
    return stored;
  }
  if (state.status === 'trial' || state.source === 'trial') {
    const trialLimit = getBillingConfig().trialEmailDailyLimit ?? TRIAL_EMAIL_DAILY_LIMIT;
    return stored == null ? trialLimit : Math.min(stored, trialLimit);
  }
  return stored ?? TRIAL_EMAIL_DAILY_LIMIT;
}

/** Defaults applied to new trial accounts (from Cobranças block). */
export function getTrialDefaults() {
  const cfg = getBillingConfig();
  return {
    days: cfg.trialDays,
    maxMonitors: cfg.trialMaxMonitors ?? TRIAL_MAX_MONITORS,
    emailDailyLimit: cfg.trialEmailDailyLimit ?? TRIAL_EMAIL_DAILY_LIMIT,
  };
}

/** Paid/permanent/admin plan unlocks e-mail (without admin override). */
export function hasPaidEmailPlan(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const state = getBillingState(user);
  return (
    state.entitled === true &&
    (state.source === 'paid' || state.source === 'permanent' || state.source === 'admin')
  );
}

/** Full app access (monitors, dashboard). Admins always; others need active entitlement. */
export function hasAppAccess(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.active === false) return false;
  return getBillingState(user).entitled === true;
}

/** E-mail alerts: needs entitlement, then paid plan or admin grant. */
export function canUseEmailAlerts(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (!getBillingState(user).entitled) return false;
  if (hasPaidEmailPlan(user)) return true;
  return user.emailNotifyAllowed === true;
}

export function getBillingState(user) {
  if (!user) {
    return {
      entitled: false,
      status: 'none',
      planId: null,
      expiresAt: null,
      trialEndsAt: null,
      source: null,
    };
  }

  // Site owner/admin always keeps e-mail notifications available.
  if (user.role === 'admin') {
    return {
      entitled: true,
      status: 'active',
      planId: user.billingPlanId || 'admin',
      expiresAt: null,
      trialEndsAt: user.billingTrialEndsAt || null,
      source: 'admin',
      permanent: true,
    };
  }

  const now = Date.now();
  const billingActive = user.billingActive !== false;
  const trialEndsAt = user.billingTrialEndsAt || trialEndsAtFor(user.createdAt);
  const paidExpiresAt = user.billingExpiresAt || null;
  const planId = user.billingPlanId || null;

  if (!billingActive) {
    return {
      entitled: false,
      status: 'inactive',
      planId,
      expiresAt: paidExpiresAt,
      trialEndsAt,
      source: null,
      permanent: false,
    };
  }

  if (user.billingPermanent === true) {
    return {
      entitled: true,
      status: 'active',
      planId: planId || 'permanent',
      expiresAt: null,
      trialEndsAt,
      source: 'permanent',
      permanent: true,
    };
  }

  if (paidExpiresAt && Date.parse(paidExpiresAt) > now) {
    return {
      entitled: true,
      status: 'active',
      planId,
      expiresAt: paidExpiresAt,
      trialEndsAt,
      source: 'paid',
      permanent: false,
    };
  }

  if (trialEndsAt && Date.parse(trialEndsAt) > now) {
    return {
      entitled: true,
      status: 'trial',
      planId: null,
      expiresAt: trialEndsAt,
      trialEndsAt,
      source: 'trial',
      permanent: false,
    };
  }

  return {
    entitled: false,
    status: 'expired',
    planId,
    expiresAt: paidExpiresAt || trialEndsAt,
    trialEndsAt,
    source: null,
    permanent: false,
  };
}

export function applyBillingFields(user) {
  const state = getBillingState(user);
  return {
    billingActive: user.billingActive !== false,
    billingPlanId: user.billingPlanId || null,
    billingExpiresAt: user.billingExpiresAt || null,
    billingTrialEndsAt: user.billingTrialEndsAt || trialEndsAtFor(user.createdAt),
    billing: state,
  };
}

/** Unlock e-mail option only for paid/permanent plans (not trial). */
export function syncEmailAccessFromBilling(user) {
  if (hasPaidEmailPlan(user)) {
    return {
      emailNotifyAllowed: true,
    };
  }
  // Keep an explicit admin grant; otherwise lock.
  if (user?.emailNotifyAllowed === true) {
    return { emailNotifyAllowed: true };
  }
  return {
    emailNotifyAllowed: false,
    emailNotifyStatus: 'off',
  };
}

async function mpFetch(pathname, { method = 'GET', body, accessToken, headers = {} } = {}) {
  const token = accessToken || getBillingConfig().mercadoPago.accessToken;
  if (!token) throw new Error('Mercado Pago não configurado (access token).');
  const res = await fetch(`https://api.mercadopago.com${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const cause = Array.isArray(data?.cause) ? data.cause.map((c) => c.description || c.code).join('; ') : '';
    const msg = cause || data?.message || data?.error || text || `HTTP ${res.status}`;
    throw new Error(`Mercado Pago: ${msg}`);
  }
  return data;
}

/** Create in-page Pix checkout (QR) instead of redirecting to Checkout Pro. */
function assertPlanCheckoutAllowed(user, plan) {
  const state = getBillingState(user);
  if (
    state.entitled &&
    state.source === 'paid' &&
    state.planId === plan.id &&
    state.expiresAt &&
    Date.parse(state.expiresAt) > Date.now()
  ) {
    throw new Error(
      'Este plano já está ativo. Novo pagamento só fica disponível após o vencimento da assinatura.'
    );
  }
  if (state.entitled && state.permanent && state.planId === plan.id) {
    throw new Error('Este plano já está ativo de forma permanente.');
  }
}

function resolveCheckoutPlan(planId) {
  const cfg = getBillingConfig();
  const plan = (cfg.plans || []).find((p) => p.id === planId && p.active !== false);
  if (!plan) throw new Error('Plano inválido ou inativo.');
  if (!cfg.mercadoPago.accessToken) {
    throw new Error('Mercado Pago sem access token. Configure em Cobranças.');
  }
  const amount = Number(plan.price);
  if (!(amount > 0)) throw new Error('Valor do plano inválido.');
  return { cfg, plan, amount };
}

export async function createCheckoutForUser({ user, planId, req }) {
  const { plan, amount } = resolveCheckoutPlan(planId);
  assertPlanCheckoutAllowed(user, plan);

  const paymentId = randomUUID();
  const base = appBaseUrl(req);

  const mpPayment = await mpFetch('/v1/payments', {
    method: 'POST',
    headers: { 'X-Idempotency-Key': paymentId },
    body: {
      transaction_amount: amount,
      description: `MonitorWeb — e-mail ${plan.label}`,
      payment_method_id: 'pix',
      payer: {
        email: user.email,
      },
      external_reference: paymentId,
      notification_url: `${base}/api/billing/webhook`,
      metadata: {
        user_id: user.id,
        plan_id: plan.id,
        payment_id: paymentId,
        method: 'pix',
      },
    },
  });

  const tx = mpPayment.point_of_interaction?.transaction_data || {};
  const record = {
    id: paymentId,
    userId: user.id,
    planId: plan.id,
    amount,
    days: Number(plan.days),
    maxMonitors: Number(plan.maxMonitors) || PAID_DEFAULT_MAX_MONITORS,
    method: 'pix',
    status: mpPayment.status === 'approved' ? 'approved' : 'pending',
    mpPreferenceId: null,
    mpPaymentId: mpPayment.id != null ? String(mpPayment.id) : null,
    initPoint: tx.ticket_url || null,
    qrCode: tx.qr_code || null,
    createdAt: new Date().toISOString(),
    paidAt: mpPayment.status === 'approved' ? new Date().toISOString() : null,
  };
  const list = readPayments();
  list.push(record);
  writePayments(list);

  return {
    payment: {
      id: record.id,
      planId: record.planId,
      amount: record.amount,
      days: record.days,
      status: record.status,
      method: 'pix',
      mpPaymentId: record.mpPaymentId,
      createdAt: record.createdAt,
    },
    plan: {
      id: plan.id,
      label: plan.label,
      days: plan.days,
      price: plan.price,
      maxMonitors: plan.maxMonitors,
      features: plan.features,
    },
    mpPaymentId: record.mpPaymentId,
    status: mpPayment.status,
    qrCode: tx.qr_code || null,
    qrCodeBase64: tx.qr_code_base64 || null,
    ticketUrl: tx.ticket_url || null,
  };
}

/** Create in-page credit/debit card payment from Card Payment Brick token. */
export async function createCardPaymentForUser({ user, planId, cardFormData, req }) {
  const { plan, amount } = resolveCheckoutPlan(planId);
  assertPlanCheckoutAllowed(user, plan);

  const token = String(cardFormData?.token || '').trim();
  const paymentMethodId = String(cardFormData?.payment_method_id || '').trim();
  const installments = Math.max(1, Number(cardFormData?.installments) || 1);
  if (!token) throw new Error('Token do cartão ausente.');
  if (!paymentMethodId) throw new Error('Método de pagamento do cartão ausente.');

  const paymentId = randomUUID();
  const base = appBaseUrl(req);
  const identification = cardFormData?.payer?.identification || {};
  const body = {
    transaction_amount: amount,
    token,
    description: `MonitorWeb — ${plan.label}`,
    installments,
    payment_method_id: paymentMethodId,
    payer: {
      email: user.email,
      ...(identification?.type && identification?.number
        ? {
            identification: {
              type: String(identification.type),
              number: String(identification.number),
            },
          }
        : {}),
    },
    external_reference: paymentId,
    notification_url: `${base}/api/billing/webhook`,
    metadata: {
      user_id: user.id,
      plan_id: plan.id,
      payment_id: paymentId,
      method: 'card',
    },
  };
  if (cardFormData?.issuer_id != null && String(cardFormData.issuer_id).trim() !== '') {
    body.issuer_id = Number(cardFormData.issuer_id);
  }

  const mpPayment = await mpFetch('/v1/payments', {
    method: 'POST',
    headers: { 'X-Idempotency-Key': paymentId },
    body,
  });

  const record = {
    id: paymentId,
    userId: user.id,
    planId: plan.id,
    amount,
    days: Number(plan.days),
    maxMonitors: Number(plan.maxMonitors) || PAID_DEFAULT_MAX_MONITORS,
    method: 'card',
    status: mpPayment.status === 'approved' ? 'approved' : mpPayment.status || 'pending',
    mpPreferenceId: null,
    mpPaymentId: mpPayment.id != null ? String(mpPayment.id) : null,
    initPoint: null,
    qrCode: null,
    createdAt: new Date().toISOString(),
    paidAt: mpPayment.status === 'approved' ? new Date().toISOString() : null,
    statusDetail: mpPayment.status_detail || null,
  };
  const list = readPayments();
  list.push(record);
  writePayments(list);

  return {
    payment: {
      id: record.id,
      planId: record.planId,
      amount: record.amount,
      days: record.days,
      status: record.status,
      method: 'card',
      mpPaymentId: record.mpPaymentId,
      createdAt: record.createdAt,
    },
    plan: {
      id: plan.id,
      label: plan.label,
      days: plan.days,
      price: plan.price,
      maxMonitors: plan.maxMonitors,
      features: plan.features,
    },
    mpPaymentId: record.mpPaymentId,
    status: mpPayment.status,
    statusDetail: mpPayment.status_detail || null,
    approved: mpPayment.status === 'approved',
  };
}

export async function getCheckoutStatus(localPaymentId, userId) {
  const payments = readPayments();
  const record = payments.find((p) => p.id === localPaymentId && p.userId === userId);
  if (!record) return null;
  if (!record.mpPaymentId) {
    return { payment: record, status: record.status };
  }
  try {
    const mpPayment = await fetchMpPayment(record.mpPaymentId);
    return {
      payment: record,
      status: mpPayment.status,
      statusDetail: mpPayment.status_detail,
      mpPaymentId: String(mpPayment.id),
      approved: mpPayment.status === 'approved',
    };
  } catch {
    return { payment: record, status: record.status };
  }
}

async function fetchMpPayment(paymentId) {
  return mpFetch(`/v1/payments/${paymentId}`);
}

function verifyWebhookSignature(req) {
  const secret = getBillingConfig().mercadoPago.webhookSecret;
  if (!secret) return { ok: true, skipped: true };
  const xSignature = req.headers['x-signature'];
  const xRequestId = req.headers['x-request-id'];
  if (!xSignature || !xRequestId) {
    return { ok: false, reason: 'headers ausentes' };
  }
  const parts = Object.fromEntries(
    String(xSignature)
      .split(',')
      .map((p) => p.trim().split('='))
      .filter((p) => p.length === 2)
  );
  const ts = parts.ts;
  const hash = parts.v1;
  if (!ts || !hash) return { ok: false, reason: 'ts/v1 ausentes' };

  const dataId = String(req.query?.['data.id'] || req.query?.id || req.body?.data?.id || '');
  // Mercado Pago docs: try with and without lowercase for hex ids
  const candidates = [dataId, dataId.toLowerCase()];
  for (const id of candidates) {
    const manifest = `id:${id};request-id:${xRequestId};ts:${ts};`;
    const digest = createHmac('sha256', secret).update(manifest).digest('hex');
    try {
      const a = Buffer.from(digest, 'utf8');
      const b = Buffer.from(String(hash), 'utf8');
      if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true };
    } catch {
      /* continue */
    }
  }
  return { ok: false, reason: 'hash não confere' };
}

/**
 * Activate paid plan on user. `updateUser` injected to avoid circular import with auth.js
 */
export async function activatePayment({ paymentRecord, mpPayment, updateUser, findUser }) {
  if (!paymentRecord || !updateUser) return null;
  const days = Number(paymentRecord.days) || 1;
  const userId = paymentRecord.userId;
  const current = findUser ? findUser(userId) : null;
  const now = Date.now();
  const existingExpires = current?.billingExpiresAt ? Date.parse(current.billingExpiresAt) : 0;
  const base = existingExpires > now ? existingExpires : now;
  const expiresAt = new Date(base + days * 24 * 60 * 60 * 1000).toISOString();

  const cfg = getBillingConfig();
  const plan = (cfg.plans || []).find((p) => p.id === paymentRecord.planId);
  const planMax = plan?.maxMonitors || paymentRecord.maxMonitors || PAID_DEFAULT_MAX_MONITORS;
  const nextMax = Math.max(Number(current?.maxMonitors) || 0, Number(planMax) || PAID_DEFAULT_MAX_MONITORS);

  const updated = updateUser(userId, {
    billingActive: true,
    billingPlanId: paymentRecord.planId,
    billingExpiresAt: expiresAt,
    emailNotifyAllowed: true,
    maxMonitors: nextMax,
    billingGraceFromPaidAt: null,
    billingGraceForExpiresAt: null,
    billingExpiryWarn5dFor: null,
    billingExpiryWarn3dFor: null,
    billingExpiryWarn1dFor: null,
  });

  const list = readPayments();
  const idx = list.findIndex((p) => p.id === paymentRecord.id);
  const alreadyApproved = idx >= 0 && list[idx].status === 'approved';
  const receiptAlreadySent = idx >= 0 && Boolean(list[idx].receiptSentAt);
  if (idx >= 0) {
    list[idx] = {
      ...list[idx],
      status: 'approved',
      mpPaymentId: mpPayment?.id != null ? String(mpPayment.id) : list[idx].mpPaymentId,
      paidAt: list[idx].paidAt || new Date().toISOString(),
      receiptSentAt: list[idx].receiptSentAt || null,
    };
    writePayments(list);
  }

  // Envia comprovante na primeira confirmação (ou se a tentativa anterior falhou).
  if (!receiptAlreadySent) {
    void sendPaymentReceipt({
      user: updated || current,
      plan,
      paymentRecord: idx >= 0 ? list[idx] : paymentRecord,
      expiresAt,
      mpPayment,
    }).catch((err) => console.error('[billing] recibo', err?.message || err));
  }

  return updated;
}

async function sendPaymentReceipt({ user, plan, paymentRecord, expiresAt, mpPayment }) {
  const { isMailConfigured, sendPaymentReceiptEmail, appBaseUrl } = await import('./mail.js');
  if (!isMailConfigured()) {
    console.warn('[billing] recibo não enviado: e-mail não configurado');
    return;
  }
  const email = user?.email;
  if (!email) return;

  await sendPaymentReceiptEmail({
    to: email,
    planLabel: plan?.label || paymentRecord.planId,
    planDays: plan?.days || paymentRecord.days,
    planPrice: plan?.price ?? paymentRecord.amount,
    maxMonitors: plan?.maxMonitors || paymentRecord.maxMonitors || PAID_DEFAULT_MAX_MONITORS,
    features: plan?.features,
    expiresAt,
    paymentId: paymentRecord.id,
    mpPaymentId: mpPayment?.id != null ? String(mpPayment.id) : paymentRecord.mpPaymentId,
    paidAt: paymentRecord.paidAt || new Date().toISOString(),
    appUrl: `${appBaseUrl(null)}/#billing`,
  });

  const list = readPayments();
  const idx = list.findIndex((p) => p.id === paymentRecord.id);
  if (idx >= 0) {
    list[idx] = { ...list[idx], receiptSentAt: new Date().toISOString() };
    writePayments(list);
  }
}

function findOrBuildPaymentRecord(mpPayment) {
  const external = String(mpPayment.external_reference || '');
  const payments = readPayments();
  let record = external ? payments.find((p) => p.id === external) : null;
  if (!record) {
    const metaPayId = mpPayment.metadata?.payment_id;
    if (metaPayId) record = payments.find((p) => p.id === metaPayId);
  }
  if (!record) {
    record = payments.find((p) => p.mpPaymentId && String(p.mpPaymentId) === String(mpPayment.id));
  }
  if (record) return record;

  // Fallback: build from MP metadata / amount match against plans
  const metaUserId = mpPayment.metadata?.user_id;
  const metaPlanId = mpPayment.metadata?.plan_id;
  const cfg = getBillingConfig();
  let plan = metaPlanId ? cfg.plans.find((p) => p.id === metaPlanId) : null;
  if (!plan) {
    const amount = Number(mpPayment.transaction_amount);
    plan = cfg.plans.find((p) => Number(p.price) === amount && p.active !== false);
  }
  if (!metaUserId || !plan) return null;

  const paymentId = external || String(mpPayment.metadata?.payment_id || randomUUID());
  record = {
    id: paymentId,
    userId: metaUserId,
    planId: plan.id,
    amount: Number(plan.price),
    days: Number(plan.days),
    status: 'pending',
    mpPreferenceId: null,
    mpPaymentId: String(mpPayment.id),
    initPoint: null,
    createdAt: new Date().toISOString(),
    paidAt: null,
  };
  payments.push(record);
  writePayments(payments);
  return record;
}

export async function applyApprovedMpPayment(mpPayment, { updateUser, findUser, notifyAccount }) {
  if (!mpPayment || mpPayment.status !== 'approved') {
    return { ok: true, status: mpPayment?.status || 'unknown' };
  }
  const record = findOrBuildPaymentRecord(mpPayment);
  if (!record) {
    console.warn('[billing] pagamento aprovado sem registro local', mpPayment.id, mpPayment.external_reference);
    return { ok: true, unmatched: true, mpPaymentId: String(mpPayment.id) };
  }
  if (record.status === 'approved') {
    return { ok: true, already: true, userId: record.userId };
  }

  const user = await activatePayment({
    paymentRecord: record,
    mpPayment,
    updateUser,
    findUser,
  });

  if (user && notifyAccount) {
    try {
      notifyAccount(user);
    } catch {
      /* ignore */
    }
  }

  return { ok: true, activated: true, userId: record.userId };
}

export async function reconcileMpPayment(mpPaymentId, hooks) {
  const mpPayment = await fetchMpPayment(mpPaymentId);
  return applyApprovedMpPayment(mpPayment, hooks);
}

export async function handleWebhook(req, { updateUser, findUser, notifyAccount }) {
  const sig = verifyWebhookSignature(req);
  if (!sig.ok) {
    // Still accept: we re-validate by fetching the payment with our access token.
    console.warn('[billing] webhook assinatura:', sig.reason || 'inválida — seguindo via API');
  }

  const type = req.body?.type || req.body?.action || req.query?.type || '';
  const dataId =
    req.body?.data?.id ||
    req.query?.['data.id'] ||
    req.query?.id ||
    null;

  const isPayment =
    String(type).includes('payment') || req.body?.topic === 'payment' || req.query?.topic === 'payment';

  if (!isPayment || !dataId) {
    return { ok: true, ignored: true };
  }

  const mpPayment = await fetchMpPayment(dataId);
  return applyApprovedMpPayment(mpPayment, { updateUser, findUser, notifyAccount });
}

export const billingRouter = Router();
export const billingWebhookRouter = Router();

billingWebhookRouter.post('/webhook', async (req, res) => {
  try {
    const auth = await import('./auth.js');
    const notify = await import('./notify.js');
    const result = await handleWebhook(req, {
      updateUser: (id, patch) => auth.updateUserRecordPublic(id, patch),
      findUser: (id) => auth.findUserByIdPublic(id),
      notifyAccount: (user) => notify.notifyAccount(user),
    });
    // Always 200 so Mercado Pago marks delivery as OK.
    res.status(200).json(result);
  } catch (err) {
    console.error('[billing] webhook', err?.message || err);
    // Still 200 to avoid endless retries on transient processing errors after we logged them.
    // Return 500 only when we couldn't even parse — MP will retry.
    res.status(500).json({ error: err?.message || 'webhook error' });
  }
});

billingWebhookRouter.get('/webhook', async (_req, res) => {
  res.status(200).json({ ok: true });
});

/** Authenticated billing API (mounted under /api/billing with requireAuth). */
billingRouter.get('/plans', (_req, res) => {
  res.json(publicBillingConfig());
});

billingRouter.get('/me', (req, res) => {
  const cfg = publicBillingConfig();
  res.json({
    billing: req.user?.billing || null,
    plans: cfg.plans,
    trialDays: cfg.trialDays,
    trialMaxMonitors: cfg.trialMaxMonitors,
    trialEmailDailyLimit: cfg.trialEmailDailyLimit,
    mercadoPago: cfg.mercadoPago,
  });
});

billingRouter.post('/checkout', async (req, res) => {
  try {
    const auth = await import('./auth.js');
    const notify = await import('./notify.js');
    const user = auth.findUserByIdPublic(req.user.id);
    if (!user) return res.status(401).json({ error: 'Não autenticado' });
    const planId = String(req.body?.planId || '');
    const result = await createCheckoutForUser({ user, planId, req });
    if (result.status === 'approved' && result.mpPaymentId) {
      await applyApprovedMpPayment(await fetchMpPayment(result.mpPaymentId), {
        updateUser: (id, patch) => auth.updateUserRecordPublic(id, patch),
        findUser: (id) => auth.findUserByIdPublic(id),
        notifyAccount: (u) => notify.notifyAccount(u),
      });
    }
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err?.message || 'Falha ao criar pagamento' });
  }
});

billingRouter.post('/checkout/card', async (req, res) => {
  try {
    const auth = await import('./auth.js');
    const notify = await import('./notify.js');
    const user = auth.findUserByIdPublic(req.user.id);
    if (!user) return res.status(401).json({ error: 'Não autenticado' });
    const planId = String(req.body?.planId || '');
    const cardFormData = req.body?.cardFormData || req.body || {};
    const result = await createCardPaymentForUser({ user, planId, cardFormData, req });
    if (result.approved && result.mpPaymentId) {
      const applied = await applyApprovedMpPayment(await fetchMpPayment(result.mpPaymentId), {
        updateUser: (id, patch) => auth.updateUserRecordPublic(id, patch),
        findUser: (id) => auth.findUserByIdPublic(id),
        notifyAccount: (u) => notify.notifyAccount(u),
      });
      return res.status(201).json({ ...result, ...applied, activated: true });
    }
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err?.message || 'Falha ao pagar com cartão' });
  }
});

billingRouter.get('/checkout/:id/status', async (req, res) => {
  try {
    const auth = await import('./auth.js');
    const notify = await import('./notify.js');
    const status = await getCheckoutStatus(req.params.id, req.user.id);
    if (!status) return res.status(404).json({ error: 'Pagamento não encontrado' });

    if (status.approved && status.mpPaymentId) {
      const applied = await applyApprovedMpPayment(await fetchMpPayment(status.mpPaymentId), {
        updateUser: (id, patch) => auth.updateUserRecordPublic(id, patch),
        findUser: (id) => auth.findUserByIdPublic(id),
        notifyAccount: (u) => notify.notifyAccount(u),
      });
      return res.json({ ...status, ...applied });
    }
    res.json(status);
  } catch (err) {
    res.status(400).json({ error: err?.message || 'Falha ao consultar pagamento' });
  }
});

billingRouter.get('/payments', (req, res) => {
  res.json({ payments: listPayments({ userId: req.user.id, limit: 50 }) });
});
