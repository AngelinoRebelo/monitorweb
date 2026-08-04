import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import routes from './routes.js';
import { startScheduler } from './scheduler.js';
import { DATA_DIR } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use('/api', routes);
app.use(express.static(publicDir));

app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MonitorWeb ouvindo em http://0.0.0.0:${PORT}`);
  console.log(`Dados em: ${DATA_DIR}`);
  startScheduler();
});
