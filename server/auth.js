import fs from 'node:fs';
import path from 'node:path';
import {
  createHmac,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  randomUUID,
} from 'node:crypto';
import { Router } from 'express';
import { DATA_DIR, countMonitorsByUser, deleteUserData, listMonitors } from './db.js';
import { unscheduleMonitor } from './scheduler.js';
import {
  appBaseUrl,
  isMailConfigured,
  mailProvider,
  sendPasswordResetEmail,
} from './mail.js';
import { getBillingState, getEffectiveMonitorLimit, TRIAL_MAX_MONITORS } from './billing.js';

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const COOKIE_NAME = 'mw_session';
const SESSION_DAYS = 30;
const RESET_HOURS = 2;
const DEFAULT_MAX_MONITORS = Number(process.env.DEFAULT_MAX_MONITORS) || 10;
const DEFAULT_EMAIL_DAILY_LIMIT = Number(process.env.DEFAULT_EMAIL_DAILY_LIMIT) || 10;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function authSecret() {
  const secret = process.env.SESSION_SECRET || process.env.AUTH_SECRET || '';
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT) {
    console.warn(
      '[auth] SESSION_SECRET não definido — use uma chave forte no Railway. Gerando temporária (sessões caem no redeploy).'
    );
  }
  if (!globalThis.__mwSessionSecret) {
    globalThis.__mwSessionSecret = randomBytes(32).toString('hex');
  }
  return globalThis.__mwSessionSecret;
}

function ensureUsersFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [] }, null, 2));
  }
}

function readUsersRaw() {
  ensureUsersFile();
  try {
    const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return Array.isArray(data.users) ? data.users : [];
  } catch {
    return [];
  }
}

function writeUsers(users) {
  ensureUsersFile();
  const tmp = `${USERS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ users }, null, 2));
  fs.renameSync(tmp, USERS_FILE);
}

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, SCRYPT_PARAMS);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const [algo, saltB64, hashB64] = String(stored || '').split('$');
    if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = scryptSync(password, salt, expected.length, SCRYPT_PARAMS);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromB64url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64');
}

function signSession(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac('sha256', authSecret()).update(body).digest());
  return `${body}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = b64url(createHmac('sha256', authSecret()).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(fromB64url(body).toString('utf8'));
    if (!payload?.uid || !payload?.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeUser(user, { isFirst = false } = {}) {
  const status = ['off', 'pending', 'approved'].includes(user.emailNotifyStatus)
    ? user.emailNotifyStatus
    : 'off';
  const dailyLimit =
    user.emailNotifyDailyLimit == null || Number.isNaN(Number(user.emailNotifyDailyLimit))
      ? DEFAULT_EMAIL_DAILY_LIMIT
      : Math.max(0, Number(user.emailNotifyDailyLimit));
  const createdAt = user.createdAt || new Date().toISOString();
  const trialDays = Number(process.env.BILLING_TRIAL_DAYS) || 30;
  const billingTrialEndsAt =
    user.billingTrialEndsAt ||
    new Date(Date.parse(createdAt) + trialDays * 24 * 60 * 60 * 1000).toISOString();
  return {
    ...user,
    role: user.role === 'admin' || isFirst ? 'admin' : 'user',
    active: user.active !== false,
    maxMonitors:
      user.maxMonitors == null || Number.isNaN(Number(user.maxMonitors))
        ? DEFAULT_MAX_MONITORS
        : Math.max(0, Number(user.maxMonitors)),
    emailNotifyAllowed: user.emailNotifyAllowed === true,
    emailNotifyStatus: status,
    emailNotifyDailyLimit: dailyLimit,
    emailNotifySentDate: user.emailNotifySentDate || null,
    emailNotifySentCount: Number(user.emailNotifySentCount) || 0,
    billingActive: user.billingActive !== false,
    billingPlanId: user.billingPlanId || null,
    billingExpiresAt: user.billingExpiresAt || null,
    billingTrialEndsAt,
    resetTokenHash: user.resetTokenHash || null,
    resetExpires: user.resetExpires || null,
    resetRequestedAt: user.resetRequestedAt || null,
  };
}

/** Ensure first account is admin and fill missing fields. */
export function ensureUserRoles() {
  const users = readUsersRaw()
    .slice()
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  if (!users.length) return;
  let changed = false;
  const next = users.map((u, i) => {
    const normalized = normalizeUser(u, { isFirst: i === 0 });
    if (
      normalized.role !== u.role ||
      normalized.active !== u.active ||
      normalized.maxMonitors !== u.maxMonitors
    ) {
      changed = true;
    }
    return normalized;
  });
  // Keep exactly one "first" admin: if someone else already admin, still promote first if none
  if (!next.some((u) => u.role === 'admin')) {
    next[0].role = 'admin';
    changed = true;
  }
  if (changed) writeUsers(next);
}

function readUsers() {
  ensureUserRoles();
  return readUsersRaw().map((u) => normalizeUser(u));
}

function publicUser(user) {
  if (!user) return null;
  const sentToday =
    user.emailNotifySentDate === todayKey() ? Number(user.emailNotifySentCount) || 0 : 0;
  const billing = getBillingState(user);
  const allowed = billing.entitled === true;
  return {
    id: user.id,
    email: user.email,
    role: user.role || 'user',
    active: user.active !== false,
    maxMonitors: user.maxMonitors ?? DEFAULT_MAX_MONITORS,
    createdAt: user.createdAt,
    monitorCount: countMonitorsByUser(user.id),
    emailNotifyAllowed: allowed,
    emailNotifyStatus: allowed ? user.emailNotifyStatus || 'off' : 'off',
    emailNotifyDailyLimit: user.emailNotifyDailyLimit ?? DEFAULT_EMAIL_DAILY_LIMIT,
    emailNotifySentToday: sentToday,
    billingActive: user.billingActive !== false,
    billingPlanId: user.billingPlanId || null,
    billingExpiresAt: user.billingExpiresAt || null,
    billingTrialEndsAt: user.billingTrialEndsAt || null,
    billing,
    resetPending: Boolean(user.resetTokenHash && user.resetExpires && Date.parse(user.resetExpires) > Date.now()),
    resetRequestedAt: user.resetRequestedAt || null,
  };
}

function findUserById(id) {
  return readUsers().find((u) => u.id === id) || null;
}

function findUserByEmail(email) {
  const normalized = normalizeEmail(email);
  return readUsers().find((u) => u.email === normalized) || null;
}

function registrationOpen() {
  if (process.env.ALLOW_REGISTER === 'false') return false;
  return true;
}

function setSessionCookie(res, userId) {
  const token = signSession({
    uid: userId,
    exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
  const secure = Boolean(process.env.RAILWAY_ENVIRONMENT) || process.env.NODE_ENV === 'production';
  res.setHeader(
    'Set-Cookie',
    [
      `${COOKIE_NAME}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
      secure ? 'Secure' : '',
    ]
      .filter(Boolean)
      .join('; ')
  );
}

function clearSessionCookie(res) {
  const secure = Boolean(process.env.RAILWAY_ENVIRONMENT) || process.env.NODE_ENV === 'production';
  res.setHeader(
    'Set-Cookie',
    [
      `${COOKIE_NAME}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=0',
      secure ? 'Secure' : '',
    ]
      .filter(Boolean)
      .join('; ')
  );
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  }
  return out;
}

function updateUserRecord(id, patch) {
  const users = readUsersRaw();
  const idx = users.findIndex((u) => u.id === id);
  if (idx < 0) return null;
  const current = normalizeUser(users[idx], { isFirst: false });
  const next = normalizeUser({ ...current, ...patch, id: current.id, email: current.email });
  users[idx] = next;
  writeUsers(users.map((u) => normalizeUser(u)));
  return findUserById(id);
}

/** Public wrappers for billing/webhook modules (avoid circular import issues). */
export function updateUserRecordPublic(id, patch) {
  const updated = updateUserRecord(id, patch);
  return updated ? publicUser(updated) : null;
}

export function findUserByIdPublic(id) {
  return findUserById(id);
}

function createResetTokenForUser(userId) {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + RESET_HOURS * 60 * 60 * 1000).toISOString();
  updateUserRecord(userId, {
    resetTokenHash: hashToken(token),
    resetExpires: expires,
    resetRequestedAt: new Date().toISOString(),
  });
  return { token, expires };
}

function clearReset(userId) {
  updateUserRecord(userId, {
    resetTokenHash: null,
    resetExpires: null,
    resetRequestedAt: null,
  });
}

export function attachUser(req, _res, next) {
  const cookies = parseCookies(req);
  const payload = verifySessionToken(cookies[COOKIE_NAME]);
  if (payload) {
    const user = findUserById(payload.uid);
    if (user && user.active !== false) req.user = publicUser(user);
  }
  next();
}

export function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.path === '/health') return next();
  if (req.path.startsWith('/auth')) return next();
  return res.status(401).json({ error: 'Não autenticado', code: 'UNAUTHORIZED' });
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Não autenticado' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito ao administrador' });
  return next();
}

export function requirePageAuth(req, res, next) {
  if (req.user) return next();
  return res.redirect('/login.html');
}

export function getOldestUserId() {
  const users = readUsers()
    .slice()
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return users[0]?.id || null;
}

export function getUserQuota(userId) {
  const user = findUserById(userId);
  if (!user) return { maxMonitors: 0, used: 0, remaining: 0, active: false };
  const used = countMonitorsByUser(userId);
  const maxMonitors = getEffectiveMonitorLimit(user);
  return {
    maxMonitors,
    used,
    remaining: Math.max(0, maxMonitors - used),
    active: user.active !== false,
    trialMaxMonitors: TRIAL_MAX_MONITORS,
  };
}

/** Used by change notifications to decide if e-mail alerts are active. */
export function getApprovedEmailNotify(userId) {
  const user = findUserById(userId);
  if (!user || user.active === false) return null;
  const billing = getBillingState(user);
  if (!billing.entitled) return null;
  if (user.emailNotifyStatus !== 'approved') return null;
  return {
    email: user.email,
    userId: user.id,
    dailyLimit: user.emailNotifyDailyLimit ?? DEFAULT_EMAIL_DAILY_LIMIT,
  };
}

/** Reserve one daily e-mail slot. Returns false if limit reached. */
export function consumeEmailNotifyQuota(userId) {
  const user = findUserById(userId);
  if (!user) return false;
  const today = todayKey();
  const count = user.emailNotifySentDate === today ? Number(user.emailNotifySentCount) || 0 : 0;
  const limit = user.emailNotifyDailyLimit ?? DEFAULT_EMAIL_DAILY_LIMIT;
  if (count >= limit) return false;
  updateUserRecord(userId, {
    emailNotifySentDate: today,
    emailNotifySentCount: count + 1,
  });
  return true;
}

export function bootstrapAdminFromEnv() {
  const email = normalizeEmail(process.env.BOOTSTRAP_EMAIL || '');
  const password = process.env.BOOTSTRAP_PASSWORD || '';
  if (!email || !password) return;
  if (findUserByEmail(email)) return;
  const users = readUsersRaw();
  users.push(
    normalizeUser(
      {
        id: randomUUID(),
        email,
        passwordHash: hashPassword(password),
        role: users.length === 0 ? 'admin' : 'user',
        active: true,
        maxMonitors: DEFAULT_MAX_MONITORS,
        createdAt: new Date().toISOString(),
      },
      { isFirst: users.length === 0 }
    )
  );
  writeUsers(users);
  console.log(`[auth] Usuário bootstrap criado: ${email}`);
}

export const authRouter = Router();

authRouter.get('/status', (req, res) => {
  const users = readUsers();
  res.json({
    authenticated: Boolean(req.user),
    user: req.user || null,
    registrationOpen: registrationOpen(),
    hasUsers: users.length > 0,
  });
});

authRouter.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Não autenticado' });
  res.json({ user: req.user, quota: getUserQuota(req.user.id) });
});

authRouter.post('/register', (req, res) => {
  if (!registrationOpen()) {
    return res.status(403).json({
      error: 'Cadastro fechado pelo administrador (ALLOW_REGISTER=false).',
    });
  }

  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'E-mail inválido' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Senha deve ter pelo menos 8 caracteres' });
  }
  if (findUserByEmail(email)) {
    return res.status(409).json({ error: 'Este e-mail já está cadastrado' });
  }

  const users = readUsersRaw();
  const isFirst = users.length === 0;
  const createdAt = new Date().toISOString();
  const trialEndsAt = new Date(Date.parse(createdAt) + 30 * 24 * 60 * 60 * 1000).toISOString();
  const user = normalizeUser(
    {
      id: randomUUID(),
      email,
      passwordHash: hashPassword(password),
      role: isFirst ? 'admin' : 'user',
      active: true,
      maxMonitors: isFirst ? DEFAULT_MAX_MONITORS : TRIAL_MAX_MONITORS,
      createdAt,
      billingActive: true,
      billingTrialEndsAt: trialEndsAt,
      emailNotifyAllowed: true,
    },
    { isFirst }
  );
  users.push(user);
  writeUsers(users.map((u, i) => normalizeUser(u, { isFirst: i === 0 && users.length === 1 })));
  setSessionCookie(res, user.id);
  res.status(201).json({ user: publicUser(findUserById(user.id)) });
});

authRouter.post('/login', (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');
  const user = findUserByEmail(email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos' });
  }
  if (user.active === false) {
    return res.status(403).json({ error: 'Conta desativada. Contate o administrador.' });
  }
  setSessionCookie(res, user.id);
  res.json({ user: publicUser(user) });
});

authRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

/** User requests or cancels e-mail change notifications (needs billing entitlement). */
authRouter.post('/email-notify', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Não autenticado' });
  const user = findUserById(req.user.id);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });

  const emit = (u) => {
    const pub = publicUser(u);
    import('./notify.js')
      .then((m) => m.notifyAccount(pub))
      .catch(() => {});
    return pub;
  };

  const want = Boolean(req.body?.enabled);
  if (!want) {
    const updated = updateUserRecord(user.id, { emailNotifyStatus: 'off' });
    return res.json({
      user: emit(updated),
      message: 'Notificações por e-mail desativadas.',
    });
  }

  const billing = getBillingState(user);
  if (!billing.entitled) {
    return res.status(402).json({
      error: 'Assine um plano para liberar notificações por e-mail.',
      code: 'BILLING_REQUIRED',
      billing,
    });
  }

  const updated = updateUserRecord(user.id, {
    emailNotifyAllowed: true,
    emailNotifyStatus: 'approved',
  });
  res.json({
    user: emit(updated),
    message: 'Notificações por e-mail ativadas.',
  });
});

authRouter.post('/change-password', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Não autenticado' });
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Nova senha deve ter pelo menos 8 caracteres' });
  }
  const user = findUserById(req.user.id);
  if (!user || !verifyPassword(currentPassword, user.passwordHash)) {
    return res.status(401).json({ error: 'Senha atual incorreta' });
  }
  updateUserRecord(user.id, { passwordHash: hashPassword(newPassword) });
  clearReset(user.id);
  res.json({ ok: true });
});

/** User requests password recovery — e-mail is sent when mail is configured. */
authRouter.post('/forgot', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const mailOk = isMailConfigured();
  const generic = {
    ok: true,
    mailed: false,
    message: mailOk
      ? 'Se o e-mail existir, enviamos um link de recuperação. Verifique a caixa de entrada e o spam.'
      : 'Se o e-mail existir, registramos o pedido. O administrador pode enviar o link (e-mail ainda não configurado no servidor).',
  };
  if (!isValidEmail(email)) return res.json(generic);
  const user = findUserByEmail(email);
  if (!user || user.active === false) return res.json(generic);

  const { token, expires } = createResetTokenForUser(user.id);
  const resetUrl = `${appBaseUrl(req)}/reset.html?token=${token}`;

  if (!mailOk) return res.json(generic);

  try {
    await sendPasswordResetEmail({ to: user.email, resetUrl, expiresAt: expires });
    return res.json({
      ok: true,
      mailed: true,
      message: 'Se o e-mail existir, enviamos um link de recuperação. Verifique a caixa de entrada e o spam.',
    });
  } catch (err) {
    console.error('[mail] falha ao enviar recuperação:', err?.message || err);
    return res.json({
      ok: true,
      mailed: false,
      message:
        'Não foi possível enviar o e-mail agora. O administrador pode gerar o link no painel Admin.',
    });
  }
});

authRouter.get('/reset/validate', (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).json({ ok: false, error: 'Token inválido' });
  const hash = hashToken(token);
  const user = readUsers().find(
    (u) => u.resetTokenHash === hash && u.resetExpires && Date.parse(u.resetExpires) > Date.now()
  );
  if (!user) return res.status(400).json({ ok: false, error: 'Link expirado ou inválido' });
  res.json({ ok: true, email: user.email });
});

authRouter.post('/reset', (req, res) => {
  const token = String(req.body?.token || '');
  const newPassword = String(req.body?.password || '');
  if (!token) return res.status(400).json({ error: 'Token inválido' });
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Senha deve ter pelo menos 8 caracteres' });
  }
  const hash = hashToken(token);
  const user = readUsers().find(
    (u) => u.resetTokenHash === hash && u.resetExpires && Date.parse(u.resetExpires) > Date.now()
  );
  if (!user) return res.status(400).json({ error: 'Link expirado ou inválido' });
  updateUserRecord(user.id, { passwordHash: hashPassword(newPassword) });
  clearReset(user.id);
  res.json({ ok: true, message: 'Senha atualizada. Faça login.' });
});

export const adminRouter = Router();

adminRouter.use(requireAdmin);

adminRouter.get('/users', (_req, res) => {
  const users = readUsers()
    .slice()
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map(publicUser);
  res.json({
    users,
    defaultMaxMonitors: DEFAULT_MAX_MONITORS,
    defaultEmailDailyLimit: DEFAULT_EMAIL_DAILY_LIMIT,
    mail: { configured: isMailConfigured(), provider: mailProvider() },
  });
});

adminRouter.patch('/users/:id', (req, res) => {
  const user = findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

  const patch = {};
  if (req.body?.active != null) patch.active = Boolean(req.body.active);
  if (req.body?.maxMonitors != null) {
    patch.maxMonitors = Math.max(0, Math.min(1000, Number(req.body.maxMonitors) || 0));
  }
  if (req.body?.role === 'admin' || req.body?.role === 'user') {
    if (user.id === req.user.id && req.body.role !== 'admin') {
      return res.status(400).json({ error: 'Você não pode remover seu próprio acesso de admin' });
    }
    patch.role = req.body.role;
  }
  if (req.body?.email) {
    const email = normalizeEmail(req.body.email);
    if (!isValidEmail(email)) return res.status(400).json({ error: 'E-mail inválido' });
    const other = findUserByEmail(email);
    if (other && other.id !== user.id) {
      return res.status(409).json({ error: 'E-mail já em uso' });
    }
    patch.email = email;
  }
  if (req.body?.emailNotifyAllowed != null) {
    patch.emailNotifyAllowed = Boolean(req.body.emailNotifyAllowed);
    if (!patch.emailNotifyAllowed) {
      patch.emailNotifyStatus = 'off';
    }
  }
  if (req.body?.emailNotifyDailyLimit != null) {
    patch.emailNotifyDailyLimit = Math.max(
      0,
      Math.min(500, Number(req.body.emailNotifyDailyLimit) || 0)
    );
  }
  if (req.body?.emailNotifyStatus != null) {
    const status = String(req.body.emailNotifyStatus);
    if (!['off', 'pending', 'approved'].includes(status)) {
      return res.status(400).json({ error: 'Status de e-mail inválido' });
    }
    patch.emailNotifyStatus = status;
  }
  if (req.body?.billingActive != null) patch.billingActive = Boolean(req.body.billingActive);
  if (req.body?.billingPlanId != null) {
    patch.billingPlanId = req.body.billingPlanId ? String(req.body.billingPlanId) : null;
  }
  if (req.body?.billingExpiresAt != null) {
    const raw = String(req.body.billingExpiresAt || '').trim();
    if (!raw) patch.billingExpiresAt = null;
    else {
      const t = Date.parse(raw);
      if (!Number.isFinite(t)) return res.status(400).json({ error: 'Data de expiração inválida' });
      patch.billingExpiresAt = new Date(t).toISOString();
    }
  }
  if (req.body?.billingTrialEndsAt != null) {
    const raw = String(req.body.billingTrialEndsAt || '').trim();
    if (!raw) patch.billingTrialEndsAt = null;
    else {
      const t = Date.parse(raw);
      if (!Number.isFinite(t)) return res.status(400).json({ error: 'Data de trial inválida' });
      patch.billingTrialEndsAt = new Date(t).toISOString();
    }
  }
  if (req.body?.billingDaysExtend != null) {
    const days = Math.max(0, Number(req.body.billingDaysExtend) || 0);
    const now = Date.now();
    const currentExp = user.billingExpiresAt ? Date.parse(user.billingExpiresAt) : 0;
    const base = currentExp > now ? currentExp : now;
    patch.billingExpiresAt = new Date(base + days * 86400000).toISOString();
    patch.billingActive = true;
  }

  const updated = updateUserRecord(user.id, patch);
  const pub = publicUser(updated);
  import('./notify.js')
    .then((m) => m.notifyAccount(pub))
    .catch(() => {});
  res.json({ user: pub });
});

adminRouter.post('/users/:id/password', (req, res) => {
  const user = findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  const password = String(req.body?.password || '');
  if (password.length < 8) {
    return res.status(400).json({ error: 'Senha deve ter pelo menos 8 caracteres' });
  }
  updateUserRecord(user.id, { passwordHash: hashPassword(password) });
  clearReset(user.id);
  res.json({ ok: true });
});

adminRouter.post('/users/:id/reset-link', async (req, res) => {
  const user = findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  const { token, expires } = createResetTokenForUser(user.id);
  const resetUrl = `${appBaseUrl(req)}/reset.html?token=${token}`;
  const sendEmail = req.body?.sendEmail !== false;

  let mailed = false;
  let mailError = null;
  if (sendEmail && isMailConfigured()) {
    try {
      await sendPasswordResetEmail({ to: user.email, resetUrl, expiresAt: expires });
      mailed = true;
    } catch (err) {
      mailError = err?.message || String(err);
      console.error('[mail] falha admin reset-link:', mailError);
    }
  }

  res.json({
    ok: true,
    email: user.email,
    expiresAt: expires,
    resetUrl,
    mailed,
    mailConfigured: isMailConfigured(),
    mailError,
  });
});

adminRouter.delete('/users/:id', (req, res) => {
  const user = findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (user.id === req.user.id) {
    return res.status(400).json({ error: 'Você não pode excluir a própria conta' });
  }
  if (user.role === 'admin') {
    const admins = readUsers().filter((u) => u.role === 'admin');
    if (admins.length <= 1) {
      return res.status(400).json({ error: 'Não é possível excluir o único administrador' });
    }
  }
  const users = readUsersRaw().filter((u) => u.id !== user.id);
  for (const m of listMonitors({ userId: user.id })) unscheduleMonitor(m.id);
  writeUsers(users);
  const deleted = deleteUserData(user.id);
  res.json({ ok: true, deleted });
});

adminRouter.get('/billing', async (_req, res) => {
  const { publicBillingConfig, listPayments, getBillingConfig } = await import('./billing.js');
  const cfg = getBillingConfig();
  res.json({
    config: publicBillingConfig(cfg),
    raw: {
      trialDays: cfg.trialDays,
      plans: cfg.plans,
      mercadoPago: {
        accessToken: cfg.mercadoPago.accessToken ? '••••' + cfg.mercadoPago.accessToken.slice(-6) : '',
        publicKey: cfg.mercadoPago.publicKey || '',
        webhookSecret: cfg.mercadoPago.webhookSecret
          ? '••••' + cfg.mercadoPago.webhookSecret.slice(-6)
          : '',
        enabled: cfg.mercadoPago.enabled,
        hasAccessToken: Boolean(cfg.mercadoPago.accessToken),
        hasWebhookSecret: Boolean(cfg.mercadoPago.webhookSecret),
      },
    },
    users: readUsers().map(publicUser),
    payments: listPayments({ limit: 100 }),
  });
});

adminRouter.put('/billing', async (req, res) => {
  const { saveBillingConfig, getBillingConfig } = await import('./billing.js');
  const patch = {};
  if (req.body?.trialDays != null) patch.trialDays = req.body.trialDays;
  if (Array.isArray(req.body?.plans)) patch.plans = req.body.plans;
  if (req.body?.mercadoPago) {
    patch.mercadoPago = { ...req.body.mercadoPago };
    // Keep previous secrets when masked / empty placeholders are sent
    const current = getBillingConfig().mercadoPago;
    if (
      !patch.mercadoPago.accessToken ||
      String(patch.mercadoPago.accessToken).startsWith('••••')
    ) {
      patch.mercadoPago.accessToken = current.accessToken;
    }
    if (
      !patch.mercadoPago.webhookSecret ||
      String(patch.mercadoPago.webhookSecret).startsWith('••••')
    ) {
      patch.mercadoPago.webhookSecret = current.webhookSecret;
    }
  }
  const config = saveBillingConfig(patch);
  res.json({ ok: true, config });
});

adminRouter.post('/billing/reconcile', async (req, res) => {
  const mpPaymentId = String(req.body?.mpPaymentId || req.body?.id || '').trim();
  if (!mpPaymentId) return res.status(400).json({ error: 'Informe mpPaymentId' });
  try {
    const billing = await import('./billing.js');
    const notify = await import('./notify.js');
    const result = await billing.reconcileMpPayment(mpPaymentId, {
      updateUser: (id, patch) => updateUserRecordPublic(id, patch),
      findUser: (id) => findUserByIdPublic(id),
      notifyAccount: (user) => notify.notifyAccount(user),
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err?.message || 'Falha ao reconciliar pagamento' });
  }
});
