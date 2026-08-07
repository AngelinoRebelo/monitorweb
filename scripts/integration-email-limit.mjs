/**
 * Integration smoke: local server + admin PATCH email daily limit.
 * Run: node scripts/integration-email-limit.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync } from 'node:crypto';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'mw-it-'));
const port = 3457 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}`;
const adminEmail = 'admin-test@example.com';
const adminPass = 'TestPass123!';
const userEmail = 'vh.limit-test@example.com';
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, SCRYPT_PARAMS);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function makeUser({ email, password, role, emailNotifyDailyLimit, emailNotifyAllowed }) {
  const now = new Date().toISOString();
  return {
    id: randomBytes(8).toString('hex'),
    email,
    passwordHash: hashPassword(password),
    role,
    active: true,
    maxMonitors: role === 'admin' ? 200 : 2,
    emailNotifyAllowed: Boolean(emailNotifyAllowed),
    emailNotifyStatus: emailNotifyAllowed ? 'approved' : 'off',
    emailNotifyDailyLimit,
    billingActive: true,
    billingPermanent: role === 'admin',
    billingPlanId: null,
    billingExpiresAt: null,
    billingTrialEndsAt: new Date(Date.now() + 15 * 86400000).toISOString(),
    createdAt: now,
    updatedAt: now,
  };
}

writeFileSync(
  path.join(dataDir, 'users.json'),
  JSON.stringify(
    {
      users: [
        makeUser({
          email: adminEmail,
          password: adminPass,
          role: 'admin',
          emailNotifyDailyLimit: 100,
          emailNotifyAllowed: true,
        }),
        makeUser({
          email: userEmail,
          password: 'UserPass123!',
          role: 'user',
          emailNotifyDailyLimit: 10,
          emailNotifyAllowed: true,
        }),
      ],
    },
    null,
    2
  )
);
writeFileSync(
  path.join(dataDir, 'store.json'),
  JSON.stringify({ monitors: [], events: [], settingsByUser: {} }, null, 2)
);

const child = spawn(process.execPath, ['server/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    ALLOW_REGISTER: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let bootLog = '';
child.stdout.on('data', (d) => {
  bootLog += d.toString();
});
child.stderr.on('data', (d) => {
  bootLog += d.toString();
});

function parseSetCookie(res) {
  const raw = res.headers.getSetCookie?.() || [];
  if (raw.length) return raw.map((c) => c.split(';')[0]).join('; ');
  const one = res.headers.get('set-cookie');
  return one ? one.split(';')[0] : '';
}

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${base}/login.html`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await sleep(150);
  }
  throw new Error(`Server não subiu.\n${bootLog}`);
}

try {
  await waitReady();
  console.log('server ready on', base);

  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPass }),
  });
  const loginText = await loginRes.text();
  assert.equal(loginRes.status, 200, `login status ${loginRes.status} ${loginText}`);
  const loginBody = JSON.parse(loginText);
  assert.equal(loginBody.user?.role, 'admin');
  const cookie = parseSetCookie(loginRes);
  assert.ok(cookie, 'cookie de sessão ausente');

  const listRes = await fetch(`${base}/api/admin/users`, {
    headers: { Cookie: cookie },
  });
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  const target = (list.users || []).find((u) => u.email === userEmail);
  assert.ok(target, 'usuário alvo não encontrado');
  assert.equal(target.emailNotifyDailyLimit, 10);

  const patchRes = await fetch(`${base}/api/admin/users/${target.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ emailNotifyDailyLimit: 35, maxMonitors: 2 }),
  });
  const patchText = await patchRes.text();
  assert.equal(patchRes.status, 200, `patch status ${patchRes.status} ${patchText}`);
  const patched = JSON.parse(patchText);
  assert.equal(patched.user.emailNotifyDailyLimit, 35, 'PATCH não devolveu 35');

  const list2 = await (
    await fetch(`${base}/api/admin/users`, { headers: { Cookie: cookie } })
  ).json();
  const target2 = list2.users.find((u) => u.email === userEmail);
  assert.equal(target2.emailNotifyDailyLimit, 35, 'limite não persistiu após reload');

  const patch2 = await fetch(`${base}/api/admin/users/${target.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ maxMonitors: 3, emailNotifyDailyLimit: 42 }),
  });
  assert.equal(patch2.status, 200);
  const body2 = await patch2.json();
  assert.equal(body2.user.maxMonitors, 3);
  assert.equal(body2.user.emailNotifyDailyLimit, 42);

  const list3 = await (
    await fetch(`${base}/api/admin/users`, { headers: { Cookie: cookie } })
  ).json();
  const target3 = list3.users.find((u) => u.email === userEmail);
  assert.equal(target3.maxMonitors, 3);
  assert.equal(target3.emailNotifyDailyLimit, 42);

  console.log('✓ integração limite de e-mail OK (10 → 35 → 42, persistido)');
} catch (err) {
  console.error('✗ integração falhou:', err.message);
  console.error(bootLog.slice(-2000));
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  await sleep(400);
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
