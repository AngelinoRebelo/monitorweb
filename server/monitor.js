import dns from 'node:dns';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { createTwoFilesPatch } from 'diff';
import { getMonitor, saveCheckResult, updateMonitor } from './db.js';
import { buildHumanChanges } from './humanDiff.js';

dns.setDefaultResultOrder('ipv4first');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const VOLATILE_JSON_KEYS = new Set([
  '_snapshotAt',
  '_fetchedAt',
  'fetchedAt',
  'serverTime',
  'timestamp',
  'generatedAt',
]);

function normalizeText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex');
}

function summarizeDiff(before, after) {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const patch = createTwoFilesPatch('antes', 'depois', before, after, '', '', {
    context: 2,
  });
  const added = afterLines.length - beforeLines.length;
  let summary = 'Conteúdo alterado';
  if (added > 0) summary = `+${added} linhas detectadas`;
  else if (added < 0) summary = `${added} linhas detectadas`;
  return { summary, diffText: patch.slice(0, 12000) };
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (VOLATILE_JSON_KEYS.has(key)) continue;
      out[key] = canonicalizeJson(value[key]);
    }
    return out;
  }
  return value;
}

function formatJsonContent(data) {
  return JSON.stringify(canonicalizeJson(data), null, 2);
}

function extractHtmlText(html, selector) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe').remove();
  const root = selector ? $(selector) : $('body').length ? $('body') : $.root();
  if (selector && root.length === 0) {
    throw new Error(`Seletor CSS não encontrado: ${selector}`);
  }
  const text = normalizeText(root.text());
  return text || normalizeText($.root().text());
}

function looksLikeSpaShell(html, text) {
  const $ = cheerio.load(html);
  const appRoots = $('#app, #root, #__next, [data-reactroot]').length > 0;
  const shortText = (text || '').length < 80;
  return appRoots && shortText;
}

function formatFetchError(err) {
  const cause = err?.cause;
  const bits = [];
  if (err?.name === 'AbortError') return 'Timeout ao buscar a página';
  if (cause?.code) bits.push(cause.code);
  if (cause?.message) bits.push(cause.message);
  else if (err?.message) bits.push(err.message);
  const msg = bits.filter(Boolean).join(' — ') || 'Falha de rede ao buscar a página';
  if (/fetch failed/i.test(msg) && !cause?.code) {
    return 'Falha de rede ao acessar o site (possível bloqueio do servidor de origem ao Railway)';
  }
  return msg;
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
    Accept: accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    ...(referer ? { Referer: referer } : {}),
    ...(origin ? { Origin: origin } : {}),
  };
}

async function decodeResponseBody(res) {
  const buf = Buffer.from(await res.arrayBuffer());
  const ctype = res.headers.get('content-type') || '';
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

async function fetchResponse(url, { accept } = {}) {
  const maxAttempts = 3;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: buildHeaders(url, { accept }),
      });
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 700 * attempt));
        continue;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

function gestaoInteligenteRifaApi(pageUrl) {
  try {
    const u = new URL(pageUrl);
    if (!/(^|\.)gestaointeligent\.com\.br$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/rifa\/([^/]+)\/?$/i);
    if (!m) return null;
    return `${u.origin}/api/public/rifa-link/${encodeURIComponent(m[1])}`;
  } catch {
    return null;
  }
}

function discoverApiCandidates(pageUrl, html) {
  const candidates = [];
  const known = gestaoInteligenteRifaApi(pageUrl);
  if (known) candidates.push(known);

  try {
    const u = new URL(pageUrl);
    const slugMatch = u.pathname.match(/^\/rifa\/([^/]+)\/?$/i);
    if (slugMatch) {
      candidates.push(`${u.origin}/api/public/rifa-link/${encodeURIComponent(slugMatch[1])}`);
    }
  } catch {
    /* ignore */
  }

  const meta = html.match(/<meta[^>]+name=["']gi-api-base["'][^>]*content=["']([^"']*)["']/i);
  const base = (meta?.[1] || '').replace(/\/$/, '');
  if (base) {
    const knownPath = gestaoInteligenteRifaApi(pageUrl);
    if (knownPath) {
      try {
        const path = new URL(knownPath).pathname;
        candidates.push(`${base}${path}`);
      } catch {
        /* ignore */
      }
    }
  }

  return [...new Set(candidates)];
}

async function tryJsonSources(urls) {
  for (const url of urls) {
    try {
      const res = await fetchResponse(url, { accept: 'application/json' });
      if (!res.ok) continue;
      const type = (res.headers.get('content-type') || '').toLowerCase();
      const body = await decodeResponseBody(res);
      if (!type.includes('json') && !body.trim().startsWith('{') && !body.trim().startsWith('[')) {
        continue;
      }
      const data = JSON.parse(body);
      return {
        sourceUrl: url,
        content: formatJsonContent(data),
        kind: 'json',
      };
    } catch {
      /* try next */
    }
  }
  return null;
}

function summarizeRifaJson(content) {
  try {
    const data = JSON.parse(content);
    const reservations = Array.isArray(data.reservations) ? data.reservations : [];
    const paid = reservations.filter((r) => r.status === 'paid').length;
    const reserved = reservations.filter((r) => r.status === 'reserved').length;
    const name = data.name || 'Rifa';
    return `${name}: ${reservations.length} reservas (${paid} pagas, ${reserved} reservadas)`;
  } catch {
    return null;
  }
}

export async function checkMonitor(id, { previousContent } = {}) {
  const monitor = getMonitor(id);
  if (!monitor) throw new Error('Monitor não encontrado');

  try {
    let content;
    let sourceUrl = monitor.url;
    let kind = 'html';

    const preferredApi = gestaoInteligenteRifaApi(monitor.url);
    const earlyJson = await tryJsonSources(
      [preferredApi, monitor.url.endsWith('.json') ? monitor.url : null].filter(Boolean)
    );

    if (earlyJson) {
      content = earlyJson.content;
      sourceUrl = earlyJson.sourceUrl;
      kind = 'json';
    } else {
      const res = await fetchResponse(monitor.url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const type = (res.headers.get('content-type') || '').toLowerCase();
      const body = await decodeResponseBody(res);

      if (type.includes('json') || body.trim().startsWith('{') || body.trim().startsWith('[')) {
        content = formatJsonContent(JSON.parse(body));
        kind = 'json';
      } else {
        const htmlText = extractHtmlText(body, monitor.selector);
        if (looksLikeSpaShell(body, htmlText) || htmlText.length < 80) {
          const api = await tryJsonSources(discoverApiCandidates(monitor.url, body));
          if (api) {
            content = api.content;
            sourceUrl = api.sourceUrl;
            kind = 'json';
          } else {
            content = htmlText;
            kind = 'html-shell';
          }
        } else {
          content = htmlText;
          kind = 'html';
        }
      }
    }

    const hash = hashContent(content);
    const prevWasShell =
      previousContent != null &&
      previousContent.length > 0 &&
      previousContent.length < 80 &&
      !previousContent.trim().startsWith('{');
    const switchedToApi = kind === 'json' && prevWasShell;
    const isFirst = !monitor.lastHash || switchedToApi;
    const changed = !isFirst && monitor.lastHash !== hash;

    let summary = isFirst
      ? kind === 'json'
        ? 'Primeira captura dos dados dinâmicos (API)'
        : 'Primeira captura registrada'
      : null;
    let diffText = '';
    let changes = [];
    if (changed) {
      const before = previousContent || '';
      const diff = summarizeDiff(before, content);
      summary = summarizeRifaJson(content) || diff.summary;
      diffText = diff.diffText;
      changes = buildHumanChanges(before, content);
    } else if (isFirst && kind === 'json') {
      summary = summarizeRifaJson(content) || summary;
    }

    const result = saveCheckResult(id, {
      hash,
      content,
      status: changed ? 'changed' : kind === 'html-shell' ? 'error' : 'ok',
      error:
        kind === 'html-shell'
          ? 'Página parece SPA sem API descoberta; monitorando só o HTML estático'
          : null,
      changed,
      summary,
      diffText,
      changes,
      sourceUrl,
      contentKind: kind,
    });

    updateMonitor(id, {
      lastContent: content.slice(0, 200000),
      lastSourceUrl: sourceUrl,
      lastContentKind: kind,
    });

    return {
      ...result,
      changed,
      isFirst,
      content,
      sourceUrl,
      kind,
    };
  } catch (err) {
    const message = formatFetchError(err);
    const result = saveCheckResult(id, {
      hash: null,
      content: null,
      status: 'error',
      error: message,
      changed: false,
    });
    return { ...result, changed: false, error: message };
  }
}
