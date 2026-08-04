import express from 'express';
import dns from 'node:dns';

dns.setDefaultResultOrder('ipv4first');

const app = express();
const PORT = Number(process.env.PORT) || 8080;
const SECRET = process.env.RELAY_SECRET || '';
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS) || 25000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

function unauthorized(res) {
  return res.status(401).json({ ok: false, error: 'Não autorizado' });
}

function requireAuth(req, res, next) {
  if (!SECRET) {
    return res.status(500).json({ ok: false, error: 'RELAY_SECRET não configurado' });
  }
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const alt = req.get('x-relay-secret') || '';
  if (token !== SECRET && alt !== SECRET) return unauthorized(res);
  return next();
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'monitorweb-relay',
    region: process.env.FLY_REGION || process.env.RAILWAY_REGION || 'unknown',
  });
});

app.post('/v1/fetch', requireAuth, async (req, res) => {
  const url = String(req.body?.url || '').trim();
  const accept = String(req.body?.accept || '').trim();

  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ ok: false, error: 'URL inválida' });
    }
  } catch {
    return res.status(400).json({ ok: false, error: 'URL inválida' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const started = Date.now();
    const upstream = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept:
          accept ||
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        Referer: (() => {
          try {
            return `${new URL(url).origin}/`;
          } catch {
            return '';
          }
        })(),
      },
    });

    const buf = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';

    res.status(200).json({
      ok: upstream.ok,
      status: upstream.status,
      statusText: upstream.statusText,
      contentType,
      elapsedMs: Date.now() - started,
      bodyBase64: buf.toString('base64'),
      bytes: buf.length,
      relayRegion: process.env.FLY_REGION || null,
    });
  } catch (err) {
    const message =
      err?.name === 'AbortError'
        ? 'Timeout ao buscar a página no relay'
        : err?.cause?.code
          ? `${err.message} (${err.cause.code})`
          : err?.message || String(err);
    res.status(502).json({ ok: false, error: message });
  } finally {
    clearTimeout(timeout);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`monitorweb-relay ouvindo em :${PORT}`);
});
