import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { createTwoFilesPatch } from 'diff';
import { getMonitor, saveCheckResult, updateMonitor } from './db.js';
import { buildHumanChanges } from './humanDiff.js';
import { fetchResponse, decodeResponseBody, formatFetchError } from './fetchPage.js';

const VOLATILE_JSON_KEYS = new Set([
  '_snapshotAt',
  '_fetchedAt',
  'fetchedAt',
  'serverTime',
  'timestamp',
  'generatedAt',
]);

/** New content must appear this many consecutive checks before counting as a real change. */
const CHANGE_CONFIRMATIONS = 2;

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

function isSeiUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return /(^|\.)sei\./i.test(host) || (/sei/i.test(host) && /\.gov\.br$/i.test(host));
  } catch {
    return false;
  }
}

/** Strip tokens / noise that change without real process updates. */
function scrubVolatileText(text) {
  return normalizeText(
    String(text || '')
      .replace(/PESQUISA_PROCESSUAL\d+/gi, ' ')
      .replace(/\bhdn[A-Za-z0-9_]+\b/gi, ' ')
      .replace(/\b[a-f0-9]{32,}\b/gi, ' ')
      .replace(/\b[A-Za-z0-9_-]{40,}\b/g, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? ' ' : m))
      .replace(/Digite o c[oó]digo da imagem:?/gi, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/[ \t]{2,}/g, ' ')
  );
}

/**
 * Detect SEI/captcha/restricted captures that should NOT overwrite the baseline
 * or be reported as content changes.
 */
function detectUnusableCapture(html, text) {
  const blob = `${html || ''}\n${text || ''}`.toLowerCase();
  if (/digite o c[oó]digo da imagem/.test(blob)) {
    return 'Captcha do SEI detectado; captura ignorada (não é alteração do processo).';
  }
  if (/processo ou documento de acesso restrito/.test(blob)) {
    const hasUseful =
      /lista de protocolos|lista de andamentos/i.test(text) &&
      /(despacho|of[ií]cio|publica[cç][aã]o|anexo|externo)/i.test(text) &&
      String(text).length > 800;
    if (!hasUseful) {
      return 'Página de acesso restrito sem conteúdo útil; captura ignorada.';
    }
  }
  return null;
}

function extractSeiRelevantText(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe').remove();
  // Do not remove <form>: SEI wraps almost the whole page in a form.
  $('img[src*="aptcha"], img[src*="Captcha"], img[id*="Captcha"], img[id*="captcha"]').each((_, el) => {
    $(el).closest('tr, div').first().remove();
  });

  const chunks = [];
  $('table').each((_, el) => {
    const t = $(el).text();
    if (
      /Lista de Protocolos|Lista de Andamentos|Protocolo|Andamento|Documentos/i.test(t) &&
      t.replace(/\s+/g, ' ').trim().length > 40
    ) {
      chunks.push(normalizeText(t));
    }
  });

  if (chunks.length) {
    return scrubVolatileText(chunks.join('\n\n'));
  }

  const body = $('body').length ? $('body') : $.root();
  return scrubVolatileText(body.text());
}

function extractHtmlText(html, selector, { pageUrl } = {}) {
  if (!selector && pageUrl && isSeiUrl(pageUrl)) {
    return extractSeiRelevantText(html);
  }

  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe').remove();
  const root = selector ? $(selector) : $('body').length ? $('body') : $.root();
  if (selector && root.length === 0) {
    throw new Error(`Seletor CSS não encontrado: ${selector}`);
  }
  const text = normalizeText(root.text());
  const raw = text || normalizeText($.root().text());
  return pageUrl && isSeiUrl(pageUrl) ? scrubVolatileText(raw) : scrubVolatileText(raw);
}

function looksLikeSpaShell(html, text) {
  const $ = cheerio.load(html);
  const appRoots = $('#app, #root, #__next, [data-reactroot]').length > 0;
  const shortText = (text || '').length < 80;
  return appRoots && shortText;
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
        const pathName = new URL(knownPath).pathname;
        candidates.push(`${base}${pathName}`);
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

/**
 * Decide if hash change is confirmed (debounce) or still pending.
 * Returns { changed, isFirst, pendingHash, pendingHashCount, pendingContent, statusNote }
 */
function resolveChangeState(monitor, hash, content, { switchedToApi }) {
  const isFirst = !monitor.lastHash || switchedToApi;
  if (isFirst) {
    return {
      changed: false,
      isFirst: true,
      pendingHash: null,
      pendingHashCount: 0,
      pendingContent: null,
      updateBaseline: true,
      statusNote: null,
    };
  }

  if (hash === monitor.lastHash) {
    return {
      changed: false,
      isFirst: false,
      pendingHash: null,
      pendingHashCount: 0,
      pendingContent: null,
      updateBaseline: true,
      statusNote: null,
    };
  }

  const samePending = monitor.pendingHash === hash;
  const count = samePending ? Number(monitor.pendingHashCount || 0) + 1 : 1;

  if (count >= CHANGE_CONFIRMATIONS) {
    return {
      changed: true,
      isFirst: false,
      pendingHash: null,
      pendingHashCount: 0,
      pendingContent: null,
      updateBaseline: true,
      statusNote: null,
    };
  }

  return {
    changed: false,
    isFirst: false,
    pendingHash: hash,
    pendingHashCount: count,
    pendingContent: content.slice(0, 200000),
    updateBaseline: false,
    statusNote: `Possível alteração — confirmando (${count}/${CHANGE_CONFIRMATIONS})`,
  };
}

export async function checkMonitor(id, { previousContent } = {}) {
  const monitor = getMonitor(id);
  if (!monitor) throw new Error('Monitor não encontrado');

  try {
    let content;
    let sourceUrl = monitor.url;
    let kind = 'html';
    let rawHtml = '';

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
      rawHtml = body;

      if (type.includes('json') || body.trim().startsWith('{') || body.trim().startsWith('[')) {
        content = formatJsonContent(JSON.parse(body));
        kind = 'json';
      } else {
        const htmlText = extractHtmlText(body, monitor.selector, { pageUrl: monitor.url });
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

    if (kind === 'html' || kind === 'html-shell') {
      const blocked = detectUnusableCapture(rawHtml, content);
      if (blocked) {
        const result = saveCheckResult(id, {
          hash: null,
          content: null,
          status: 'error',
          error: blocked,
          changed: false,
          updateHash: false,
          contentKind: kind,
          sourceUrl,
        });
        return { ...result, changed: false, error: blocked, isFirst: false, kind };
      }
    }

    const hash = hashContent(content);
    const prevWasShell =
      previousContent != null &&
      previousContent.length > 0 &&
      previousContent.length < 80 &&
      !previousContent.trim().startsWith('{');
    const switchedToApi = kind === 'json' && prevWasShell;

    const decision = resolveChangeState(monitor, hash, content, { switchedToApi });
    const { changed, isFirst } = decision;

    let summary = isFirst
      ? kind === 'json'
        ? 'Primeira captura dos dados dinâmicos (API)'
        : 'Primeira captura registrada'
      : decision.statusNote;
    let diffText = '';
    let changes = [];
    if (changed) {
      const before = previousContent || monitor.pendingContent || '';
      const diff = summarizeDiff(before, content);
      summary = summarizeRifaJson(content) || diff.summary;
      diffText = diff.diffText;
      changes = buildHumanChanges(before, content);
    } else if (isFirst && kind === 'json') {
      summary = summarizeRifaJson(content) || summary;
    }

    const result = saveCheckResult(id, {
      hash: decision.updateBaseline ? hash : null,
      content: decision.updateBaseline ? content : null,
      status: changed ? 'changed' : kind === 'html-shell' ? 'error' : 'ok',
      error:
        kind === 'html-shell'
          ? 'Página parece SPA sem API descoberta; monitorando só o HTML estático'
          : decision.statusNote,
      changed,
      summary,
      diffText,
      changes,
      sourceUrl,
      contentKind: kind,
      updateHash: decision.updateBaseline,
      lastContent: decision.updateBaseline ? content.slice(0, 200000) : undefined,
      pendingHash: decision.pendingHash,
      pendingHashCount: decision.pendingHashCount,
      pendingContent: decision.pendingContent,
    });

    // Keep lastSourceUrl / kind even while confirming.
    updateMonitor(id, {
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
      confirming: Boolean(decision.pendingHash),
    };
  } catch (err) {
    const message = formatFetchError(err, monitor.url);
    const result = saveCheckResult(id, {
      hash: null,
      content: null,
      status: 'error',
      error: message,
      changed: false,
      updateHash: false,
    });
    return { ...result, changed: false, error: message };
  }
}
