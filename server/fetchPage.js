import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import https from 'node:https';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';

dns.setDefaultResultOrder('ipv4first');

const execFileAsync = promisify(execFile);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS) || 20000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

function proxyUrl() {
  return process.env.PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
}

function dispatcher() {
  const proxy = proxyUrl();
  if (proxy) return new ProxyAgent(proxy);
  return new Agent({
    connect: { family: 4, timeout: FETCH_TIMEOUT_MS },
    bodyTimeout: FETCH_TIMEOUT_MS,
    headersTimeout: FETCH_TIMEOUT_MS,
  });
}

export function formatFetchError(err, url = '') {
  if (err?.name === 'AbortError') return 'Timeout ao buscar a página';

  const cause = err?.cause;
  const nested = cause?.errors?.[0];
  const code = cause?.code || nested?.code || err?.code;
  const detail = cause?.message || nested?.message || err?.message || 'Falha de rede';
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  const isSei = /sei\.rj\.gov\.br$/i.test(host);

  if (code === 'EAI_AGAIN' || code === 'ENOTFOUND') {
    return `DNS falhou ao resolver o site (${code})`;
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || /timeout/i.test(detail)) {
    if (isSei) {
      return 'Timeout no SEI a partir do Railway. O SEI bloqueia/não responde de servidores nos EUA — configure PROXY_URL (Brasil) ou rode o monitor localmente.';
    }
    return `Timeout de conexão com o site (${code || 'timeout'})`;
  }
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED') {
    return `Conexão recusada/resetada pelo site (${code})`;
  }
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return `Problema de certificado SSL do site (${code})`;
  }

  if (/fetch failed/i.test(detail) && isSei) {
    return 'Falha ao acessar o SEI pelo Railway (rede bloqueada). Configure PROXY_URL no Brasil ou use o app em rede local.';
  }
  if (/fetch failed/i.test(detail) && code) return `Falha de rede (${code})`;
  if (/fetch failed/i.test(detail)) {
    return 'Falha de rede ao acessar o site (possível bloqueio do servidor de origem ao Railway)';
  }
  return code ? `${detail} (${code})` : detail;
}

function buildHeaders(url, { accept } = {}) {
  let origin = '';
  let referer = '';
  try {
    const u = new URL(url);
    origin = u.origin;
    referer = `${u.origin}/`;
  } catch {
    /* ignore */
  }
  return {
    'User-Agent': USER_AGENT,
    Accept:
      accept ||
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Connection: 'close',
    ...(referer ? { Referer: referer } : {}),
    ...(origin ? { Origin: origin } : {}),
  };
}

export async function decodeResponseBody(resLike) {
  const buf = Buffer.isBuffer(resLike.body)
    ? resLike.body
    : Buffer.from(await resLike.arrayBuffer());
  const ctype = (resLike.headers?.get?.('content-type') ||
    resLike.headers?.['content-type'] ||
    '') + '';
  const m = ctype.match(/charset\s*=\s*["']?([^;"'\s]+)/i);
  let encoding = (m?.[1] || 'utf-8').trim().toLowerCase();
  if (encoding === 'iso-8859-1' || encoding === 'latin1' || encoding === 'windows-1252') {
    encoding = 'latin1';
  }
  try {
    return new TextDecoder(encoding).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

function headerMapToGetters(headers) {
  const lower = {};
  for (const [k, v] of Object.entries(headers || {})) {
    lower[String(k).toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return {
    get(name) {
      return lower[String(name).toLowerCase()] || null;
    },
  };
}

async function fetchWithNodeHttp(url, { accept } = {}) {
  const u = new URL(url);
  const { address } = await dnsPromises.lookup(u.hostname, { family: 4 });
  const lib = u.protocol === 'http:' ? http : https;
  const headers = {
    ...buildHeaders(url, { accept }),
    Host: u.hostname,
  };

  return await new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: address,
        servername: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers,
        family: 4,
        timeout: FETCH_TIMEOUT_MS,
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage || '',
            headers: headerMapToGetters(res.headers),
            body: Buffer.concat(chunks),
            async arrayBuffer() {
              return Buffer.concat(chunks);
            },
            async text() {
              return Buffer.concat(chunks).toString('utf8');
            },
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(Object.assign(new Error('Timeout de conexão'), { code: 'ETIMEDOUT' }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchWithCurl(url, { accept } = {}) {
  const args = [
    '-sS',
    '-L',
    '--max-time',
    String(Math.ceil(FETCH_TIMEOUT_MS / 1000)),
    '--ipv4',
    '-A',
    USER_AGENT,
    '-H',
    `Accept: ${
      accept ||
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
    }`,
    '-H',
    'Accept-Language: pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    '-w',
    '\n__MW_META__:%{http_code}|%{content_type}',
    url,
  ];
  const proxy = proxyUrl();
  if (proxy) args.splice(1, 0, '-x', proxy);

  const { stdout } = await execFileAsync('curl', args, {
    maxBuffer: 12 * 1024 * 1024,
    encoding: 'buffer',
  });
  const raw = stdout.toString('binary');
  const marker = '\n__MW_META__:';
  const idx = raw.lastIndexOf(marker);
  if (idx < 0) throw new Error('Resposta inválida do curl');
  const bodyBinary = raw.slice(0, idx);
  const meta = raw.slice(idx + marker.length).trim();
  const [code, contentType = ''] = meta.split('|');
  const status = Number(code) || 0;
  const body = Buffer.from(bodyBinary, 'binary');
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: headerMapToGetters({ 'content-type': contentType }),
    body,
    async arrayBuffer() {
      return body;
    },
    async text() {
      return body.toString('utf8');
    },
  };
}

async function fetchWithUndici(url, { accept } = {}) {
  const res = await undiciFetch(url, {
    redirect: 'follow',
    headers: buildHeaders(url, { accept }),
    dispatcher: dispatcher(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = Buffer.from(await res.arrayBuffer());
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    body,
    async arrayBuffer() {
      return body;
    },
    async text() {
      return body.toString('utf8');
    },
  };
}

export async function fetchResponse(url, { accept } = {}) {
  const strategies = [
    ['https', fetchWithNodeHttp],
    ['fetch', fetchWithUndici],
    ['curl', fetchWithCurl],
  ];

  let lastError;
  for (const [name, fn] of strategies) {
    try {
      const res = await fn(url, { accept });
      if (!res) throw new Error(`Estratégia ${name} sem resposta`);
      return res;
    } catch (err) {
      lastError = err;
      console.warn(`[fetch] ${name} falhou:`, formatFetchError(err, url));
    }
  }
  const wrapped = lastError || new Error('Falha de rede ao buscar a página');
  wrapped.message = formatFetchError(wrapped, url);
  throw wrapped;
}
