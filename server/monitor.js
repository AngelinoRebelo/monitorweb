import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { createTwoFilesPatch } from 'diff';
import { getMonitor, saveCheckResult, updateMonitor } from './db.js';
import { buildHumanChanges } from './humanDiff.js';
import { fetchResponse, decodeResponseBody, formatFetchError } from './fetchPage.js';
import { hasUsefulSeiContent, isSeiCaptchaWall, isSeiEmptyOrMissing } from './seiCapture.js';

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
/**
 * SEI: require 2 consecutive useful captures with the same fingerprint.
 * Captcha/empty skips do not clear pending — real changes still notify soon,
 * one-off HTML glitches do not.
 */
const SEI_CHANGE_CONFIRMATIONS = 2;

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
  const beforeLines = before.split('\n').filter(Boolean);
  const afterLines = after.split('\n').filter(Boolean);
  const patch = createTwoFilesPatch('antes', 'depois', before, after, '', '', {
    context: 2,
  });
  const added = afterLines.length - beforeLines.length;

  if (/\[protocolos\]|\[andamentos\]/i.test(before + after)) {
    const prevSet = new Set(beforeLines.filter((l) => !/^\[[a-z]+\]$/i.test(l)));
    const nextSet = new Set(afterLines.filter((l) => !/^\[[a-z]+\]$/i.test(l)));
    let neu = 0;
    let rem = 0;
    for (const line of nextSet) if (!prevSet.has(line)) neu += 1;
    for (const line of prevSet) if (!nextSet.has(line)) rem += 1;

    const liberated = [];
    for (const line of nextSet) {
      const m = line.match(/^(\d{6,})\s*\|\s*liberado\b/i);
      if (!m) continue;
      const id = m[1];
      const wasLocked = [...prevSet].some(
        (l) =>
          new RegExp(`^${id}\\s*\\|\\s*restrito\\b`, 'i').test(l) ||
          (new RegExp(`^${id}\\b`).test(l) && !/\|\s*liberado\b/i.test(l))
      );
      if (wasLocked) liberated.push(id);
    }

    let summary = 'Conteúdo do processo alterado';
    if (liberated.length) {
      summary =
        liberated.length === 1
          ? `Documento ${liberated[0]} liberado para acesso`
          : `${liberated.length} documentos liberados para acesso`;
    } else if (neu && rem) summary = `Processo: +${neu} / -${rem} itens`;
    else if (neu) summary = `Processo: +${neu} item(ns) novo(s)`;
    else if (rem) summary = `Processo: ${rem} item(ns) removido(s)`;
    return { summary, diffText: patch.slice(0, 12000) };
  }

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
      .replace(/\b[A-Za-z0-9_+\/=-]{40,}\b/g, (m) =>
        /[0-9]/.test(m) && /[A-Za-z]/.test(m) ? ' ' : m
      )
      .replace(/Digite o c[oó]digo da imagem:?/gi, ' ')
      .replace(/Informe o c[oó]digo de confirma[cç][aã]o:?/gi, ' ')
      .replace(/\b\d{1,2}:\d{2}:\d{2}\b/g, (t) => t.slice(0, 5)) // drop seconds from times if present alone
      .replace(/&nbsp;/gi, ' ')
      .replace(/[ \t]{2,}/g, ' ')
  );
}

function cleanSeiCell(text) {
  return scrubVolatileText(
    String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function isSeiHeaderRow(cells) {
  if (!cells.length) return true;
  const joined = cells.join(' ').toLowerCase();
  if (joined.length > 80) return false;
  if (/\d{6,}/.test(joined) || /\d{2}\/\d{2}\/\d{4}/.test(joined)) return false;
  return (
    /^(tipo|unidade|data|descri|protocolo|documento|hora)/i.test(cells[0] || '') ||
    /^(tipo do documento|data\/hora|descri[cç][aã]o|unidade|protocolo)(\s|$)/i.test(joined) ||
    cells.every((c) =>
      /^(tipo|unidade|data|data\/hora|descri[cç][aã]o|protocolo|documento|hora)s?$/i.test(c)
    )
  );
}

function looksLikeProtocolRow(cells) {
  if (cells.length < 2) return false;
  const id = cells[0] || '';
  if (!/^\d{6,}$/.test(id.replace(/\D/g, '')) && !/^\d{6,}/.test(id)) {
    // first cell may include icon text + id
    if (!/\d{6,}/.test(cells.join(' '))) return false;
  }
  const blob = cells.join(' ');
  return /(despacho|of[ií]cio|publica[cç][aã]o|anexo|externo|termo|informa[cç][aã]o|parecer|requerimento|memorando|e-mail|email)/i.test(
    blob
  ) || /\d{2}\/\d{2}\/\d{4}/.test(blob);
}

function looksLikeAndamentoRow(cells) {
  if (cells.length < 2) return false;
  const blob = cells.join(' ');
  // Date/time in first cell is the strongest signal for SEI andamentos.
  if (/^\d{2}\/\d{2}\/\d{4}/.test(cells[0] || '') && cells.length >= 2) return true;
  return /\d{2}\/\d{2}\/\d{4}/.test(blob) && /(processo|remetido|recebido|gerado|assinado)/i.test(blob);
}

function tableContextLabel($, tableEl) {
  const $table = $(tableEl);
  const bits = [];
  const caption = cleanSeiCell($table.find('caption').first().text());
  if (caption) bits.push(caption);
  const prev = $table.prevAll('h1,h2,h3,h4,legend,div,p,span,strong,b,label').slice(0, 6);
  prev.each((_, el) => {
    const t = cleanSeiCell($(el).text());
    if (t && t.length < 180) bits.push(t);
  });
  const firstRows = $table
    .find('tr')
    .slice(0, 2)
    .map((_, tr) => cleanSeiCell($(tr).text()))
    .get();
  bits.push(...firstRows);
  return bits.join(' | ');
}

function classifySeiTable($, tableEl) {
  const label = tableContextLabel($, tableEl);
  if (/lista de andamentos/i.test(label)) return 'andamentos';
  if (/lista de protocolos/i.test(label)) return 'protocolos';

  const rows = [];
  $(tableEl)
    .find('tr')
    .each((_, tr) => {
      const cells = $(tr)
        .find('th,td')
        .map((__, td) => cleanSeiCell($(td).text()))
        .get()
        .filter(Boolean);
      if (cells.length) rows.push(cells);
    });
  if (rows.length < 2) return null;

  let protocolHits = 0;
  let andamentoHits = 0;
  for (const cells of rows.slice(0, 12)) {
    if (isSeiHeaderRow(cells)) continue;
    if (looksLikeAndamentoRow(cells)) andamentoHits += 1;
    else if (looksLikeProtocolRow(cells)) protocolHits += 1;
  }
  if (andamentoHits >= 2 && andamentoHits >= protocolHits) return 'andamentos';
  if (protocolHits >= 2) return 'protocolos';
  return null;
}

function protocolAccessState($, tr) {
  const $tr = $(tr);
  const $cells = $tr.find('th,td');
  const $idCell = $cells.first();
  // Blue/clickable protocol numbers are <a href> in SEI public research.
  const linkedId = $tr
    .find('a[href]')
    .filter((_, a) => /\d{6,}/.test(cleanSeiCell($(a).text())))
    .length;
  if (linkedId > 0) return 'liberado';

  const html = `${$idCell.html() || ''} ${$tr.html() || ''}`.toLowerCase();
  const lockedIcon =
    /chave|key|bloquead|restrit|cadeado|lock/.test(html) ||
    $tr.find('img[src*="chave"], img[src*="key"], img[src*="bloque"], img[src*="restrit"], img[alt*="restrit"], img[title*="restrit"]').length >
      0;
  if (lockedIcon) return 'restrito';

  // Plain text protocol id (no anchor) = not yet liberado for public access.
  if (/\d{6,}/.test($idCell.text()) && $idCell.find('a[href]').length === 0) return 'restrito';
  return 'indefinido';
}

function serializeSeiTableRows($, tableEl, kind) {
  const out = [];
  const seen = new Set();
  $(tableEl)
    .find('tr')
    .each((_, tr) => {
      const cells = $(tr)
        .find('th,td')
        .map((__, td) => cleanSeiCell($(td).text()))
        .get()
        .filter(Boolean);
      if (!cells.length || isSeiHeaderRow(cells)) return;
      if (kind === 'protocolos' && !looksLikeProtocolRow(cells) && !/\d{6,}/.test(cells[0] || '')) {
        return;
      }
      if (kind === 'andamentos' && !looksLikeAndamentoRow(cells) && !/\d{2}\/\d{2}\/\d{4}/.test(cells.join(' '))) {
        return;
      }
      let line = cells.join(' | ');
      if (kind === 'protocolos') {
        const access = protocolAccessState($, tr);
        // Keep access state right after the protocol id so liberacao changes the fingerprint.
        if (cells.length && /\d{6,}/.test(cells[0])) {
          line = `${cells[0]} | ${access} | ${cells.slice(1).join(' | ')}`;
        } else {
          line = `${access} | ${line}`;
        }
      }
      if (!line || line.length < 8) return;
      if (seen.has(line)) return;
      seen.add(line);
      out.push(line);
    });
  return out;
}

/**
 * Detect SEI/captcha/restricted captures that should NOT overwrite the baseline
 * or be reported as content changes.
 */
function detectUnusableCapture(html, text) {
  // Real process tables always win — SEI pages often keep a captcha widget in the DOM.
  if (hasUsefulSeiContent(text)) return null;

  if (isSeiCaptchaWall(html, text)) {
    return 'Captcha do SEI detectado; captura ignorada (não é alteração do processo).';
  }
  if (isSeiEmptyOrMissing(html, text)) {
    return 'Página SEI sem conteúdo do processo; captura ignorada.';
  }
  const blob = `${html || ''}\n${text || ''}`.toLowerCase();
  if (/processo ou documento de acesso restrito/.test(blob)) {
    return 'Página de acesso restrito sem conteúdo útil; captura ignorada.';
  }
  return null;
}

function extractSeiRelevantText(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe').remove();
  // Prefer protocol/andamento tables; ignore captcha chrome that often remains in the DOM.
  $('#divInfraCaptcha, #imgCaptcha, label[for="txtInfraCaptcha"]').remove();
  $('input[name="txtInfraCaptcha"], input[name="hdnInfraCaptcha"]').remove();
  $('img[src*="aptcha"], img[src*="Captcha"], img[id*="Captcha"], img[id*="captcha"]').each((_, el) => {
    $(el).closest('tr, div, label').first().remove();
  });

  const protocolos = [];
  const andamentos = [];
  const seenProtocol = new Set();
  const seenAndamento = new Set();

  $('table').each((_, el) => {
    const kind = classifySeiTable($, el);
    if (!kind) return;
    const rows = serializeSeiTableRows($, el, kind);
    for (const row of rows) {
      if (kind === 'protocolos') {
        if (seenProtocol.has(row)) continue;
        seenProtocol.add(row);
        protocolos.push(row);
      } else {
        if (seenAndamento.has(row)) continue;
        seenAndamento.add(row);
        andamentos.push(row);
      }
    }
  });

  const parts = [];
  if (protocolos.length) {
    parts.push('[protocolos]');
    parts.push(...protocolos);
  }
  if (andamentos.length) {
    parts.push('[andamentos]');
    parts.push(...andamentos);
  }

  // Never fall back to full body on SEI — that is the main source of false positives.
  return scrubVolatileText(parts.join('\n'));
}

function extractHtmlText(html, selector, { pageUrl } = {}) {
  if (pageUrl && isSeiUrl(pageUrl)) {
    if (!selector) return extractSeiRelevantText(html);
    const $ = cheerio.load(html);
    const root = $(selector);
    if (root.length) {
      const scoped = extractSeiRelevantText(`<div>${root.html() || ''}</div>`);
      if (hasUsefulSeiContent(scoped)) return scoped;
    }
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
  return scrubVolatileText(raw);
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

/** Read firebaseConfig = { apiKey, projectId, ... } from inline SPA scripts. */
function extractFirebaseConfig(html) {
  const block = String(html || '').match(/firebaseConfig\s*=\s*\{([\s\S]*?)\}/);
  if (!block) return null;
  const body = block[1];
  const apiKey = body.match(/apiKey\s*:\s*["']([^"']+)["']/i)?.[1] || '';
  const projectId = body.match(/projectId\s*:\s*["']([^"']+)["']/i)?.[1] || '';
  if (!projectId) return null;
  return { apiKey, projectId };
}

/** collection(db, 'schedules') style references in Firebase client code. */
function extractFirestoreCollections(html) {
  const found = [];
  const re = /collection\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(String(html || '')))) {
    if (m[1] && !found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

function decodeFirestoreValue(value) {
  if (value == null || typeof value !== 'object') return null;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return Boolean(value.booleanValue);
  if ('nullValue' in value) return null;
  if ('timestampValue' in value) return value.timestampValue;
  if ('arrayValue' in value) {
    return (value.arrayValue?.values || []).map(decodeFirestoreValue);
  }
  if ('mapValue' in value) {
    const fields = value.mapValue?.fields || {};
    const out = {};
    for (const key of Object.keys(fields).sort()) {
      out[key] = decodeFirestoreValue(fields[key]);
    }
    return out;
  }
  return null;
}

function firestoreDocumentsToPlain(documents) {
  return (documents || [])
    .map((doc) => {
      const id = String(doc.name || '')
        .split('/')
        .pop();
      const fields = doc.fields || {};
      const data = { id };
      for (const key of Object.keys(fields).sort()) {
        data[key] = decodeFirestoreValue(fields[key]);
      }
      return data;
    })
    .filter((doc) => doc.id && !String(doc.id).startsWith('__'))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function firestoreListUrl(projectId, collectionId, apiKey, pageToken) {
  const path = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    projectId
  )}/databases/(default)/documents/${encodeURIComponent(collectionId)}`;
  const qs = new URLSearchParams({ pageSize: '300' });
  if (apiKey) qs.set('key', apiKey);
  if (pageToken) qs.set('pageToken', pageToken);
  return `${path}?${qs}`;
}

/**
 * SPAs that render from Firestore (e.g. escala capoeira) keep a static HTML shell.
 * Discover project/collections from the page and read the public REST API instead.
 */
async function tryFirebaseFirestoreFromHtml(html) {
  const cfg = extractFirebaseConfig(html);
  if (!cfg?.projectId) return null;
  const collections = extractFirestoreCollections(html);
  if (!collections.length) return null;

  for (const collectionId of collections) {
    try {
      let pageToken = '';
      const documents = [];
      let sourceUrl = '';
      for (let page = 0; page < 10; page += 1) {
        const url = firestoreListUrl(cfg.projectId, collectionId, cfg.apiKey, pageToken || undefined);
        if (!sourceUrl) sourceUrl = url.split('?')[0];
        const res = await fetchResponse(url, { accept: 'application/json' });
        if (!res.ok) break;
        const body = await decodeResponseBody(res);
        const data = JSON.parse(body);
        if (Array.isArray(data.documents)) documents.push(...data.documents);
        pageToken = data.nextPageToken || '';
        if (!pageToken) break;
      }
      const plain = firestoreDocumentsToPlain(documents);
      if (!plain.length) continue;
      return {
        sourceUrl,
        content: formatJsonContent(plain),
        kind: 'json',
        collectionId,
      };
    } catch {
      /* try next collection */
    }
  }
  return null;
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
    if (Array.isArray(data) && data.some((d) => d && (d.scheduleName || d.weeks))) {
      const schedules = data.filter((d) => d && (d.scheduleName || Array.isArray(d.weeks)));
      const services = schedules.reduce(
        (n, s) => n + (Array.isArray(s.weeks) ? s.weeks.reduce((w, week) => w + (week?.services?.length || 0), 0) : 0),
        0
      );
      return `Escalas: ${schedules.length} mês(es), ${services} culto(s)`;
    }
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
function resolveChangeState(monitor, hash, content, { switchedToApi, confirmations }) {
  const needed = Math.max(1, Number(confirmations) || CHANGE_CONFIRMATIONS);
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

  if (count >= needed) {
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
    statusNote: `Possível alteração — confirmando (${count}/${needed})`,
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
      const res = await fetchResponse(monitor.url, {
        cookieHost: isSeiUrl(monitor.url)
          ? (() => {
              try {
                return new URL(monitor.url).hostname;
              } catch {
                return '';
              }
            })()
          : '',
      });
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
        const firestore = await tryFirebaseFirestoreFromHtml(body);
        if (firestore) {
          content = firestore.content;
          sourceUrl = firestore.sourceUrl;
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
    }

    if (kind === 'html' || kind === 'html-shell') {
      const blocked = detectUnusableCapture(rawHtml, content);
      if (blocked) {
        // Silent skip: captcha/restricted pages are not real failures — clear any
        // stuck "error" badge from a previous attempt so the UI stays healthy.
        const result = saveCheckResult(id, {
          hash: null,
          content: null,
          status: 'ok',
          error: null,
          changed: false,
          updateHash: false,
          contentKind: kind,
          sourceUrl,
        });
        console.warn(
          `[monitor] ${monitor.name}: ${blocked} (texto=${String(content || '').length}c useful=${hasUsefulSeiContent(content)})`
        );
        return { ...result, changed: false, error: null, isFirst: false, kind, skipped: true };
      }
    }

    const hash = hashContent(content);
    const prevContent = previousContent || monitor.lastContent || '';
    const prevWasShell =
      prevContent.length > 0 &&
      prevContent.length < 80 &&
      !/^\s*[\[{]/.test(prevContent);
    // Quietly adopt JSON/Firestore data when upgrading from static HTML fingerprint.
    const switchedFromHtmlToJson =
      kind === 'json' &&
      Boolean(monitor.lastHash) &&
      prevContent.length > 0 &&
      !/^\s*[\[{]/.test(prevContent);
    const switchedToApi = (kind === 'json' && prevWasShell) || switchedFromHtmlToJson;
    // Migrating SEI monitors to canonical protocolos/andamentos fingerprint — reset baseline quietly.
    const prevSei = previousContent || monitor.lastContent || '';
    const switchedSeiFormat =
      isSeiUrl(monitor.url) &&
      /\[protocolos\]|\[andamentos\]/i.test(content || '') &&
      Boolean(prevSei) &&
      !/\[protocolos\]|\[andamentos\]/i.test(prevSei);
    // Quietly adopt "liberado/restrito" markers without notifying (format upgrade).
    const switchedSeiAccessFormat =
      isSeiUrl(monitor.url) &&
      /\|\s*(liberado|restrito)\s*\|/i.test(content || '') &&
      /\[protocolos\]/i.test(prevSei) &&
      !/\|\s*(liberado|restrito)\s*\|/i.test(prevSei);

    const decision = resolveChangeState(monitor, hash, content, {
      switchedToApi: switchedToApi || switchedSeiFormat || switchedSeiAccessFormat,
      confirmations: isSeiUrl(monitor.url) ? SEI_CHANGE_CONFIRMATIONS : CHANGE_CONFIRMATIONS,
    });
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
