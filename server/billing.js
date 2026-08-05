import fs from 'node:fs';
import path from 'node:path';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { DATA_DIR } from './db.js';
import { appBaseUrl } from './mail.js';

const CONFIG_FILE = path.join(DATA_DIR, 'billing-config.json');
const PAYMENTS_FILE = path.join(DATA_DIR, 'billing-payments.json');

const DEFAULT_PLANS = [
  { id: 'month', label: '1 mês', days: 30, price: 30, active: true },
  { id: 'biweek', label: '15 dias', days: 15, price: 20, active: true },
  { id: 'day', label: '1 dia', days: 1, price: 10, active: true },
];

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
    plans: DEFAULT_PLANS.map((p) => ({ ...p })),
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
  return {
    trialDays: Number(cfg.trialDays) > 0 ? Number(cfg.trialDays) : 30,
    plans: Array.isArray(cfg.plans) && cfg.plans.length ? cfg.plans : DEFAULT_PLANS.map((p) => ({ ...p })),
    mercadoPago: mp,
  };
}

export function saveBillingConfig(patch = {}) {
  const current = getBillingConfig();
  const next = {
    trialDays:
      patch.trialDays != null ? Math.max(0, Number(patch.trialDays) || 0) : current.trialDays,
    plans: Array.isArray(patch.plans)
      ? patch.plans.map((p) => ({
          id: String(p.id || randomUUID()).slice(0, 40),
          label: String(p.label || 'Plano').slice(0, 80),
          days: Math.max(1, Number(p.days) || 1),
          price: Math.max(0, Number(p.price) || 0),
          active: p.active !== false,
        }))
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

/** Compute billing entitlement for a user record. */
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
    };
  }

  return {
    entitled: false,
    status: 'expired',
    planId,
    expiresAt: paidExpiresAt || trialEndsAt,
    trialEndsAt,
    source: null,
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

/** When entitled, unlock email option; when not, lock it (unless admin forced allow while entitled before). */
export function syncEmailAccessFromBilling(user) {
  const state = getBillingState(user);
  if (state.entitled) {
    return {
      emailNotifyAllowed: true,
      ...(user.emailNotifyStatus === 'off' || !user.emailNotifyStatus
        ? {}
        : {}),
    };
  }
  return {
    emailNotifyAllowed: false,
    emailNotifyStatus: 'off',
  };
}

async function mpFetch(pathname, { method = 'GET', body, accessToken } = {}) {
  const token = accessToken || getBillingConfig().mercadoPago.accessToken;
  if (!token) throw new Error('Mercado Pago não configurado (access token).');
  const res = await fetch(`https://api.mercadopago.com${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
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
    const msg = data?.message || data?.error || text || `HTTP ${res.status}`;
    throw new Error(`Mercado Pago: ${msg}`);
  }
  return data;
}

export async function createCheckoutForUser({ user, planId, req }) {
  const cfg = getBillingConfig();
  const plan = (cfg.plans || []).find((p) => p.id === planId && p.active !== false);
  if (!plan) throw new Error('Plano inválido ou inativo.');
  if (!cfg.mercadoPago.accessToken) {
    throw new Error('Mercado Pago sem access token. Configure em Cobranças.');
  }

  const paymentId = randomUUID();
  const base = appBaseUrl(req);
  const preference = await mpFetch('/checkout/preferences', {
    method: 'POST',
    body: {
      items: [
        {
          id: plan.id,
          title: `MonitorWeb — e-mail ${plan.label}`,
          description: `Notificações por e-mail por ${plan.days} dia(s)`,
          quantity: 1,
          currency_id: 'BRL',
          unit_price: Number(plan.price),
        },
      ],
      payer: { email: user.email },
      external_reference: paymentId,
      notification_url: `${base}/api/billing/webhook`,
      back_urls: {
        success: `${base}/#billing?status=success`,
        pending: `${base}/#billing?status=pending`,
        failure: `${base}/#billing?status=failure`,
      },
      auto_return: 'approved',
      statement_descriptor: 'MONITORWEB',
      metadata: {
        user_id: user.id,
        plan_id: plan.id,
        payment_id: paymentId,
      },
    },
  });

  const record = {
    id: paymentId,
    userId: user.id,
    planId: plan.id,
    amount: Number(plan.price),
    days: Number(plan.days),
    status: 'pending',
    mpPreferenceId: preference.id,
    mpPaymentId: null,
    initPoint: preference.init_point || preference.sandbox_init_point || null,
    createdAt: new Date().toISOString(),
    paidAt: null,
  };
  const list = readPayments();
  list.push(record);
  writePayments(list);
  return { payment: record, initPoint: record.initPoint, preferenceId: preference.id };
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

  const updated = updateUser(userId, {
    billingActive: true,
    billingPlanId: paymentRecord.planId,
    billingExpiresAt: expiresAt,
    emailNotifyAllowed: true,
  });

  const list = readPayments();
  const idx = list.findIndex((p) => p.id === paymentRecord.id);
  if (idx >= 0) {
    list[idx] = {
      ...list[idx],
      status: 'approved',
      mpPaymentId: mpPayment?.id != null ? String(mpPayment.id) : list[idx].mpPaymentId,
      paidAt: new Date().toISOString(),
    };
    writePayments(list);
  }
  return updated;
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
  res.json({
    billing: req.user?.billing || null,
    plans: publicBillingConfig().plans,
    mercadoPago: publicBillingConfig().mercadoPago,
  });
});

billingRouter.post('/checkout', async (req, res) => {
  try {
    const auth = await import('./auth.js');
    const user = auth.findUserByIdPublic(req.user.id);
    if (!user) return res.status(401).json({ error: 'Não autenticado' });
    const planId = String(req.body?.planId || '');
    const result = await createCheckoutForUser({ user, planId, req });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err?.message || 'Falha ao criar pagamento' });
  }
});

billingRouter.get('/payments', (req, res) => {
  res.json({ payments: listPayments({ userId: req.user.id, limit: 50 }) });
});
