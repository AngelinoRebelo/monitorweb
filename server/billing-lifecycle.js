/**
 * Expiry warnings (5d / 1d) and post-paid 3-day grace trial.
 */
import { getBillingState, getTrialDefaults, PAID_GRACE_TRIAL_DAYS } from './billing.js';
import {
  appBaseUrl,
  isMailConfigured,
  sendPlanExpiryWarningEmail,
  sendPostPaidGraceEmail,
} from './mail.js';

const MS_DAY = 24 * 60 * 60 * 1000;
const WARN_WINDOWS = [
  { daysLeft: 5, field: 'billingExpiryWarn5dFor' },
  { daysLeft: 3, field: 'billingExpiryWarn3dFor' },
  { daysLeft: 1, field: 'billingExpiryWarn1dFor' },
];

function daysUntil(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (t - now) / MS_DAY;
}

function expiryKey(iso) {
  return iso ? String(iso) : '';
}

/** Apply post-paid grace trial when paid plan just expired and nothing else entitles the user. */
export async function applyPostPaidGraceIfNeeded(user, { updateUser, notifyAccount }) {
  if (!user || user.role === 'admin' || user.billingPermanent === true) return null;
  if (user.billingActive === false) return null;

  const paidExpiresAt = user.billingExpiresAt;
  if (!paidExpiresAt) return null;
  const paidEnd = Date.parse(paidExpiresAt);
  if (!Number.isFinite(paidEnd) || paidEnd > Date.now()) return null;
  if (user.billingGraceForExpiresAt === paidExpiresAt) return null;

  const state = getBillingState(user);
  if (state.entitled) return null;

  const trial = getTrialDefaults();
  const graceEndsAt = new Date(Date.now() + PAID_GRACE_TRIAL_DAYS * MS_DAY).toISOString();
  const patch = {
    billingTrialEndsAt: graceEndsAt,
    billingPlanId: null,
    emailNotifyAllowed: false,
    emailNotifyStatus: 'off',
    maxMonitors: trial.maxMonitors,
    emailNotifyDailyLimit: trial.emailDailyLimit,
    billingGraceFromPaidAt: new Date().toISOString(),
    billingGraceForExpiresAt: paidExpiresAt,
    billingExpiryWarn5dFor: null,
    billingExpiryWarn3dFor: null,
    billingExpiryWarn1dFor: null,
  };

  const updated = updateUser(user.id, patch);
  if (!updated) return null;

  if (notifyAccount) {
    try {
      notifyAccount(updated);
    } catch {
      /* ignore */
    }
  }

  if (isMailConfigured() && user.email) {
    try {
      await sendPostPaidGraceEmail({
        to: user.email,
        graceDays: PAID_GRACE_TRIAL_DAYS,
        graceEndsAt,
        appUrl: appBaseUrl(null),
      });
    } catch (err) {
      console.error('[billing-lifecycle] grace email', err?.message || err);
    }
  }

  console.log(
    `[billing-lifecycle] grace trial ${PAID_GRACE_TRIAL_DAYS}d for ${user.email} until ${graceEndsAt}`
  );
  return updated;
}

/** After grace trial ends without renewal, lock billing access. */
export async function applyBlockAfterGraceIfNeeded(user, { updateUser, notifyAccount }) {
  if (!user || user.role === 'admin' || user.billingPermanent === true) return null;
  if (user.billingActive === false) return null;
  if (!user.billingGraceForExpiresAt) return null;

  const state = getBillingState(user);
  if (state.entitled) return null;

  const updated = updateUser(user.id, {
    billingActive: false,
    emailNotifyAllowed: false,
    emailNotifyStatus: 'off',
  });
  if (!updated) return null;

  if (notifyAccount) {
    try {
      notifyAccount(updated);
    } catch {
      /* ignore */
    }
  }

  if (isMailConfigured() && user.email) {
    try {
      const { sendAccountBlockedEmail } = await import('./mail.js');
      await sendAccountBlockedEmail({
        to: user.email,
        appUrl: appBaseUrl(null),
      });
    } catch (err) {
      console.error('[billing-lifecycle] block email', err?.message || err);
    }
  }

  console.log(`[billing-lifecycle] blocked after grace → ${user.email}`);
  return updated;
}

async function maybeSendExpiryWarning(user, { updateUser }) {
  if (!user || user.role === 'admin' || user.billingPermanent === true) return;
  if (user.billingActive === false) return;
  if (!isMailConfigured() || !user.email) return;

  const state = getBillingState(user);
  if (!state.entitled || !state.expiresAt) return;
  if (state.source !== 'paid' && state.source !== 'trial') return;

  const remaining = daysUntil(state.expiresAt);
  if (remaining == null || remaining < 0) return;

  const planKind = state.source === 'paid' ? 'paid' : 'trial';
  const key = expiryKey(state.expiresAt);
  const appUrl = appBaseUrl(null);

  for (const win of WARN_WINDOWS) {
    if (remaining > win.daysLeft + 0.05) continue;
    if (user[win.field] === key) continue;

    try {
      await sendPlanExpiryWarningEmail({
        to: user.email,
        daysLeft: win.daysLeft,
        planKind,
        expiresAt: state.expiresAt,
        graceDays: planKind === 'paid' ? PAID_GRACE_TRIAL_DAYS : 0,
        appUrl,
      });
      updateUser(user.id, { [win.field]: key });
      user[win.field] = key;
      console.log(`[billing-lifecycle] warn ${win.daysLeft}d (${planKind}) → ${user.email}`);
    } catch (err) {
      console.error('[billing-lifecycle] warn email', err?.message || err);
    }
  }
}

export async function runBillingLifecycle() {
  const auth = await import('./auth.js');
  const notify = await import('./notify.js').catch(() => null);
  const list = auth.findAllUsersForLifecycle();
  const updateUser = (id, patch) => auth.updateUserRecordPublic(id, patch);
  const notifyAccount = (u) => notify?.notifyAccount?.(u);

  for (const user of list) {
    try {
      await maybeSendExpiryWarning(user, { updateUser });
      await applyPostPaidGraceIfNeeded(user, { updateUser, notifyAccount });
      // Re-read after possible grace apply
      const fresh = auth.findUserByIdPublic(user.id) || user;
      await applyBlockAfterGraceIfNeeded(fresh, { updateUser, notifyAccount });
    } catch (err) {
      console.error('[billing-lifecycle] user', user?.email, err?.message || err);
    }
  }
}
