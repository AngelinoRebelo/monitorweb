import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import routes from './routes.js';
import { startScheduler } from './scheduler.js';
import { DATA_DIR } from './db.js';
import {
  attachUser,
  requireAuth,
  requirePageAuth,
  authRouter,
  bootstrapAdminFromEnv,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const PUBLIC_FILES = new Set([
  '/login.html',
  '/styles.css',
  '/login.js',
  '/icon.svg',
  '/manifest.json',
  '/sw.js',
]);

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(attachUser);

app.use('/api/auth', authRouter);
app.use('/api', requireAuth, routes);

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (PUBLIC_FILES.has(req.path)) return next();
  if (req.path.startsWith('/api')) return next();
  // Assets under / but not the SPA shell still need auth for index.
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MonitorWeb ouvindo em http://0.0.0.0:${PORT}`);
  console.log(`Dados em: ${DATA_DIR}`);
  startScheduler();
});
