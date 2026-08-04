import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes, scryptSync, timingSafeEqual, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { DATA_DIR } from './db.js';

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const COOKIE_NAME = 'mw_session';
const SESSION_DAYS = 30;
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

function readUsers() {
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

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}

function findUserById(id) {
  return readUsers().find((u) => u.id === id) || null;
}

function findUserByEmail(email) {
  const normalized = normalizeEmail(email);
  return readUsers().find((u) => u.email === normalized) || null;
}

function registrationOpen() {
  if (process.env.ALLOW_REGISTER === 'true') return true;
  return readUsers().length === 0;
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

export function attachUser(req, _res, next) {
  const cookies = parseCookies(req);
  const payload = verifySessionToken(cookies[COOKIE_NAME]);
  if (payload) {
    const user = findUserById(payload.uid);
    if (user) req.user = publicUser(user);
  }
  next();
}

export function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.path === '/health') return next();
  if (req.path.startsWith('/auth')) return next();
  return res.status(401).json({ error: 'Não autenticado', code: 'UNAUTHORIZED' });
}

export function requirePageAuth(req, res, next) {
  if (req.user) return next();
  return res.redirect('/login.html');
}

export function bootstrapAdminFromEnv() {
  const email = normalizeEmail(process.env.BOOTSTRAP_EMAIL || '');
  const password = process.env.BOOTSTRAP_PASSWORD || '';
  if (!email || !password) return;
  if (findUserByEmail(email)) return;
  const users = readUsers();
  users.push({
    id: randomUUID(),
    email,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  });
  writeUsers(users);
  console.log(`[auth] Usuário bootstrap criado: ${email}`);
}

export const authRouter = Router();

authRouter.get('/status', (_req, res) => {
  const users = readUsers();
  res.json({
    authenticated: Boolean(_req.user),
    user: _req.user || null,
    registrationOpen: registrationOpen(),
    hasUsers: users.length > 0,
  });
});

authRouter.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Não autenticado' });
  res.json({ user: req.user });
});

authRouter.post('/register', (req, res) => {
  if (!registrationOpen()) {
    return res.status(403).json({
      error: 'Cadastro fechado. Peça ao administrador ou defina ALLOW_REGISTER=true.',
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

  const users = readUsers();
  const user = {
    id: randomUUID(),
    email,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  writeUsers(users);
  setSessionCookie(res, user.id);
  res.status(201).json({ user: publicUser(user) });
});

authRouter.post('/login', (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');
  const user = findUserByEmail(email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos' });
  }
  setSessionCookie(res, user.id);
  res.json({ user: publicUser(user) });
});

authRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});
