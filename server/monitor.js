import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { createTwoFilesPatch } from 'diff';
import { getMonitor, saveCheckResult, updateMonitor } from './db.js';

const USER_AGENT =
  'MonitorWeb/1.0 (+https://github.com; change-detection bot; polite crawler)';

function normalizeText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractContent(html, selector) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe').remove();
  const root = selector ? $(selector) : $('body').length ? $('body') : $.root();
  if (selector && root.length === 0) {
    throw new Error(`Seletor CSS não encontrado: ${selector}`);
  }
  const text = normalizeText(root.text());
  return text || normalizeText($.root().text());
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
  let summary = 'Conteúdo da página alterado';
  if (added > 0) summary = `+${added} linhas detectadas`;
  else if (added < 0) summary = `${added} linhas detectadas`;
  return { summary, diffText: patch.slice(0, 12000) };
}

export async function checkMonitor(id, { previousContent } = {}) {
  const monitor = getMonitor(id);
  if (!monitor) throw new Error('Monitor não encontrado');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);

  try {
    const res = await fetch(monitor.url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const html = await res.text();
    const content = extractContent(html, monitor.selector);
    const hash = hashContent(content);
    const isFirst = !monitor.lastHash;
    const changed = !isFirst && monitor.lastHash !== hash;

    let summary = isFirst ? 'Primeira captura registrada' : null;
    let diffText = '';
    if (changed) {
      const before = previousContent || '';
      const diff = summarizeDiff(before, content);
      summary = diff.summary;
      diffText = diff.diffText;
    }

    const result = saveCheckResult(id, {
      hash,
      content,
      status: changed ? 'changed' : 'ok',
      error: null,
      changed,
      summary,
      diffText,
    });

    // keep last content for next diff (lightweight sidecar)
    updateMonitor(id, { lastContent: content.slice(0, 200000) });

    return {
      ...result,
      changed,
      isFirst,
      content,
    };
  } catch (err) {
    const message =
      err.name === 'AbortError' ? 'Timeout ao buscar a página' : err.message || String(err);
    const result = saveCheckResult(id, {
      hash: null,
      content: null,
      status: 'error',
      error: message,
      changed: false,
    });
    return { ...result, changed: false, error: message };
  } finally {
    clearTimeout(timeout);
  }
}
