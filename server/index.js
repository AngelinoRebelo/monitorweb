import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import routes from './routes.js';
import { startScheduler } from './scheduler.js';
import { DATA_DIR, claimOrphanData } from './db.js';
import {
  attachUser,
  requireAuth,
  requireAppAccess,
  requirePageAuth,
  authRouter,
  adminRouter,
  bootstrapAdminFromEnv,
  getOldestUserId,
  ensureUserRoles,
} from './auth.js';
import { billingRouter, billingWebhookRouter } from './billing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const PUBLIC_FILES = new Set([
  '/login.html',
  '/login.js',
  '/reset.html',
  '/reset.js',
  '/styles.css',
  '/icon.svg',
  '/icon.png',
  '/manifest.json',
  '/sw.js',
]);

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(attachUser);

// Mercado Pago webhooks must be public (no session)
app.use('/api/billing', billingWebhookRouter);
// Alias for common typo configured in Mercado Pago panel (billlng)
app.use('/api/billlng', billingWebhookRouter);

app.use('/api/auth', authRouter);
app.use('/api/admin', requireAuth, adminRouter);
app.use('/api/billing', requireAuth, billingRouter);
app.use('/api', requireAuth, requireAppAccess, routes);

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (PUBLIC_FILES.has(req.path)) return next();
  if (req.path.startsWith('/api')) return next();
  if (req.path === '/admin.html' || req.path === '/admin.js') {
    if (!req.user) return res.redirect('/login.html');
    if (req.user.role !== 'admin') return res.redirect('/');
    return next();
  }
  if (req.path === '/' || req.path === '/index.html') {
    return requirePageAuth(req, res, next);
  }
  return next();
});

app.use(express.static(publicDir));

app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
  if (!req.user) return res.redirect('/login.html');
  res.sendFile(path.join(publicDir, 'index.html'));
});

bootstrapAdminFromEnv();
ensureUserRoles();
const ownerId = getOldestUserId();
if (ownerId) {
  const claimed = claimOrphanData(ownerId);
  if (claimed.monitors || claimed.events) {
    console.log(
      `[auth] Dados antigos atribuídos ao admin: ${claimed.monitors} monitores, ${claimed.events} eventos`
    );
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MonitorWeb ouvindo em http://0.0.0.0:${PORT}`);
  console.log(`Dados em: ${DATA_DIR}`);
  startScheduler();
});
