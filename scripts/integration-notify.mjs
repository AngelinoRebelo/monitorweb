/**
 * Integration: site change → event + notifyChange (SSE payload + e-mail).
 * Run: node scripts/integration-notify.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync } from 'node:crypto';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'mw-notify-'));
const fixturePort = 3900 + Math.floor(Math.random() * 200);
const fixtureUrl = `http://127.0.0.1:${fixturePort}/page`;
const adminEmail = 'notify-admin@example.com';
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const mailCalls = [];
const sseChunks = [];

process.env.DATA_DIR = dataDir;
process.env.ALLOW_REGISTER = 'false';
process.env.BREVO_API_KEY = 'test-brevo-key';
process.env.MAIL_FROM = 'MonitorWeb <alerts@example.com>';
process.env.APP_BASE_URL = 'http://127.0.0.1:3000';
process.env.FETCH_RELAY_URL = '';
process.env.PROXY_RELAY_URL = '';
process.env.PROXY_URL = '';
process.env.HTTPS_PROXY = '';
process.env.HTTP_PROXY = '';

let pageBody = `<!doctype html><html><body>
  <h1>Monitor fixture de alerta</h1>
  <p id="c">versão-1 do conteúdo monitorado para teste de notificação</p>
  <p>Linha extra para garantir texto suficiente na captura inicial do monitor.</p>
</body></html>`;

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, SCRYPT_PARAMS);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

const userId = randomBytes(8).toString('hex');
writeFileSync(
  path.join(dataDir, 'users.json'),
  JSON.stringify(
    {
      users: [
        {
          id: userId,
          email: adminEmail,
          passwordHash: hashPassword('NotifyPass123!'),
          role: 'admin',
          active: true,
          maxMonitors: 200,
          emailNotifyAllowed: true,
          emailNotifyStatus: 'approved',
          emailNotifyDailyLimit: 50,
          emailNotifySentDate: null,
          emailNotifySentCount: 0,
          billingActive: true,
          billingPermanent: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    },
    null,
    2
  )
);
writeFileSync(
  path.join(dataDir, 'store.json'),
  JSON.stringify({ monitors: [], events: [], settings: {}, settingsByUser: {} }, null, 2)
);

const fixtureServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(pageBody);
});
await new Promise((resolve) => fixtureServer.listen(fixturePort, '127.0.0.1', resolve));

const previousDispatcher = getGlobalDispatcher();
const mockAgent = new MockAgent();
mockAgent.disableNetConnect();
mockAgent.enableNetConnect('127.0.0.1');
setGlobalDispatcher(mockAgent);
mockAgent
  .get('https://api.brevo.com')
  .intercept({ path: '/v3/smtp/email', method: 'POST' })
  .reply(200, (opts) => {
    const raw = opts.body;
    const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
    mailCalls.push(JSON.parse(text));
    return { messageId: 'mock-message-id' };
  })
  .persist();

let failed = 0;
const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m, e) => {
  failed += 1;
  console.error(`  ✗ ${m}${e ? ` — ${e.message || e}` : ''}`);
};

try {
  console.log('\n== Notificações de alteração ==');

  // Import AFTER DATA_DIR is set
  const { createMonitor, getMonitor, listEvents } = await import('../server/db.js');
  const { checkMonitor } = await import('../server/monitor.js');
  const { notifyChange, addSseClient, removeSseClient } = await import('../server/notify.js');
  const { isMailConfigured } = await import('../server/mail.js');
  const { getApprovedEmailNotify } = await import('../server/auth.js');

  assert.equal(isMailConfigured(), true);
  pass('e-mail configurado (Brevo mock)');

  const approved = getApprovedEmailNotify(userId);
  assert.ok(approved?.email);
  pass(`destinatário de alerta aprovado (${approved.email})`);

  const monitor = createMonitor({
    userId,
    name: 'Fixture alerta',
    url: fixtureUrl,
    intervalMinutes: 5,
    enabled: true,
  });

  // Fake SSE client
  const fakeRes = {
    write(chunk) {
      sseChunks.push(String(chunk));
      return true;
    },
  };
  const client = addSseClient(fakeRes, userId);

  let result = await checkMonitor(monitor.id, { previousContent: '' });
  assert.ok(!result.error, result.error || 'erro inesperado no baseline');
  assert.ok(getMonitor(monitor.id).lastHash, 'baseline hash');
  pass(`baseline OK (hash=${getMonitor(monitor.id).lastHash.slice(0, 8)}…)`);

  pageBody = `<!doctype html><html><body>
  <h1>Monitor fixture de alerta</h1>
  <p id="c">versão-2-ALTERADA-${Date.now()} com mudança real no texto monitorado</p>
  <p>Linha extra para garantir texto suficiente na captura inicial do monitor.</p>
</body></html>`;
  const probe = await new Promise((resolve, reject) => {
    http
      .get(fixtureUrl, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      })
      .on('error', reject);
  });
  assert.match(probe, /versão-2-ALTERADA/);
  pass('página fixture alterada');

  // Confirmation #1
  result = await checkMonitor(monitor.id, {
    previousContent: getMonitor(monitor.id).lastContent || '',
  });
  const after1 = getMonitor(monitor.id);
  assert.equal(result.changed, false, '1ª vista ainda confirma');
  assert.equal(Number(after1.pendingHashCount || 0), 1);
  pass(`confirmando alteração (1/${2})`);

  // Confirmation #2 → notify
  result = await checkMonitor(monitor.id, {
    previousContent: getMonitor(monitor.id).lastContent || '',
  });
  assert.equal(result.changed, true, '2ª vista deve confirmar mudança');
  assert.ok(result.event, 'evento de alteração');
  pass(`mudança confirmada: ${result.event.summary}`);

  const beforeMail = mailCalls.length;
  notifyChange({ monitor: result.monitor, event: result.event });
  await sleep(1000);

  const events = listEvents({ userId, monitorId: monitor.id, limit: 10 });
  assert.ok(events.length >= 1, 'evento persistido');
  pass(`evento no histórico (${events.length})`);

  const sseJoined = sseChunks.join('');
  assert.match(sseJoined, /event: change/);
  pass('alerta SSE (tempo real) emitido');

  assert.ok(mailCalls.length > beforeMail, 'e-mail disparado');
  assert.equal(mailCalls.at(-1).to?.[0]?.email, adminEmail);
  assert.match(String(mailCalls.at(-1).subject), /MonitorWeb/);
  assert.match(String(mailCalls.at(-1).htmlContent || ''), /Mudança detectada|alteração/i);
  pass('e-mail de alteração enviado ao Brevo (mock)');

  removeSseClient(client);

  // Production config presence (no real send)
  const vars = await new Promise((resolve) => {
    const p = spawn('railway', ['variables', '--kv'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d.toString();
    });
    p.on('close', () => resolve(out));
  });
  if (/^BREVO_API_KEY=.+/m.test(vars) && /^(MAIL_FROM|EMAIL_FROM)=.+/m.test(vars)) {
    pass('produção pronta para e-mail real (BREVO + MAIL_FROM)');
  } else {
    fail('produção sem BREVO/MAIL_FROM');
  }
} catch (err) {
  fail('execução', err);
} finally {
  fixtureServer.close();
  try {
    setGlobalDispatcher(previousDispatcher);
    await mockAgent.close();
  } catch {
    /* ignore */
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(failed ? `\nFALHOU: ${failed} verificação(ões)\n` : '\nALERTAS: TODOS OS TESTES PASSARAM\n');
process.exit(failed ? 1 : 0);
