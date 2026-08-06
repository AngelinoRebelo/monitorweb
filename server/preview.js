import * as cheerio from 'cheerio';
import { fetchResponse, decodeResponseBody, formatFetchError } from './fetchPage.js';

const MAX_HTML_BYTES = 2_500_000;

const PICKER_STYLE = `
#mw-pick-banner {
  position: fixed; top: 0; left: 0; right: 0; z-index: 2147483646;
  font: 600 13px/1.35 system-ui, sans-serif;
  padding: 10px 14px;
  background: #0f2f24; color: #e8f3ec;
  border-bottom: 2px solid #d4a24c;
  box-shadow: 0 8px 24px rgba(0,0,0,.35);
}
#mw-pick-banner strong { color: #f0c674; }
.mw-pick-hover {
  outline: 2px solid #d4a24c !important;
  outline-offset: 2px !important;
  cursor: crosshair !important;
  background-color: rgba(212,162,76,.18) !important;
}
.mw-pick-selected {
  outline: 3px solid #3ecf8e !important;
  outline-offset: 2px !important;
  background-color: rgba(62,207,142,.16) !important;
}
html { scroll-padding-top: 48px; }
body { cursor: crosshair !important; }
`;

const PICKER_SCRIPT = `
(function () {
  var selected = null;
  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
  }
  function isUnique(sel) {
    try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; }
  }
  function buildSelector(el) {
    if (!el || el.nodeType !== 1 || el.id === 'mw-pick-banner') return '';
    if (el.id && /^[A-Za-z][\\w:-]*$/.test(el.id)) {
      var byId = '#' + cssEscape(el.id);
      if (isUnique(byId)) return byId;
    }
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node.tagName !== 'HTML' && node.tagName !== 'BODY') {
      if (node.id === 'mw-pick-banner') break;
      var tag = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][\\w:-]*$/.test(node.id)) {
        parts.unshift('#' + cssEscape(node.id));
        break;
      }
      var part = tag;
      var cls = (node.className && typeof node.className === 'string')
        ? node.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2)
        : [];
      if (cls.length) {
        var withCls = tag + '.' + cls.map(cssEscape).join('.');
        if (isUnique(withCls)) {
          parts.unshift(withCls);
          break;
        }
        part = withCls;
      }
      var parent = node.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === node.tagName;
        });
        if (same.length > 1) {
          part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
        }
      }
      parts.unshift(part);
      var candidate = parts.join(' > ');
      if (isUnique(candidate)) break;
      node = parent;
    }
    if (!parts.length) return 'body';
    var sel = parts.join(' > ');
    if (!sel.startsWith('#') && !sel.startsWith('body')) sel = 'body > ' + sel;
    return sel;
  }
  function textPreview(el) {
    var t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    return t.slice(0, 400);
  }
  function emit(el) {
    if (!el || el.id === 'mw-pick-banner' || el.closest('#mw-pick-banner')) return;
    if (selected) selected.classList.remove('mw-pick-selected');
    selected = el;
    selected.classList.add('mw-pick-selected');
    var selector = buildSelector(el);
    window.parent.postMessage({
      type: 'monitorweb-pick',
      selector: selector,
      tag: el.tagName.toLowerCase(),
      text: textPreview(el)
    }, '*');
  }
  document.addEventListener('mouseover', function (e) {
    var el = e.target;
    if (!el || el.id === 'mw-pick-banner' || el.closest('#mw-pick-banner')) return;
    if (el.classList.contains('mw-pick-hover')) return;
    document.querySelectorAll('.mw-pick-hover').forEach(function (n) {
      n.classList.remove('mw-pick-hover');
    });
    el.classList.add('mw-pick-hover');
  }, true);
  document.addEventListener('mouseout', function (e) {
    if (e.target && e.target.classList) e.target.classList.remove('mw-pick-hover');
  }, true);
  document.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    emit(e.target);
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      window.parent.postMessage({ type: 'monitorweb-pick-cancel' }, '*');
    }
  }, true);
})();
`;

function absolutizeUrl(base, value) {
  if (!value || /^data:|^blob:|^javascript:/i.test(value)) return value;
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

export function buildPickerDocument(rawHtml, pageUrl) {
  const $ = cheerio.load(rawHtml || '');

  $('script, noscript, iframe, object, embed, frame, frameset').remove();
  $('link[rel="preload"], link[rel="modulepreload"]').remove();
  $('[onload], [onerror], [onclick], [onmouseover], [onfocus], [onsubmit]').each((_, el) => {
    const attribs = el.attribs || {};
    for (const key of Object.keys(attribs)) {
      if (/^on/i.test(key)) $(el).removeAttr(key);
    }
  });
  $('a[href^="javascript:"], area[href^="javascript:"]').attr('href', '#');
  $('meta[http-equiv="refresh"]').remove();

  // Keep layout somewhat readable; strip remote CSS that often breaks in sandbox.
  // Prefer keeping stylesheets from same origin via absolute URLs.
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) $(el).attr('href', absolutizeUrl(pageUrl, href));
  });
  $('img[src], script[src], source[src], video[src], audio[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src) $(el).attr('src', absolutizeUrl(pageUrl, src));
  });
  $('[srcset]').each((_, el) => {
    const srcset = $(el).attr('srcset');
    if (!srcset) return;
    const next = srcset
      .split(',')
      .map((part) => {
        const bits = part.trim().split(/\s+/);
        if (!bits[0]) return part;
        bits[0] = absolutizeUrl(pageUrl, bits[0]);
        return bits.join(' ');
      })
      .join(', ');
    $(el).attr('srcset', next);
  });

  $('base').remove();
  $('head').prepend(`<base href="${pageUrl.replace(/"/g, '&quot;')}">`);
  $('head').append(`<style id="mw-pick-style">${PICKER_STYLE}</style>`);
  $('body').prepend(
    `<div id="mw-pick-banner">Clique na área que deseja monitorar. <strong>Esc</strong> cancela.</div>`
  );
  $('body').append(`<script>${PICKER_SCRIPT}</script>`);

  return $.html();
}

export async function fetchPageForPicker(url) {
  const res = await fetchResponse(url);
  if (!res.ok) {
    throw Object.assign(new Error(`HTTP ${res.status} ${res.statusText}`), {
      status: res.status,
    });
  }
  let html = await decodeResponseBody(res);
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    html = html.slice(0, MAX_HTML_BYTES);
  }
  return {
    html: buildPickerDocument(html, url),
    contentType: res.headers.get('content-type') || 'text/html',
    status: res.status,
  };
}

export function sampleWithSelector(html, selector) {
  const $ = cheerio.load(html || '');
  $('script, style, noscript, svg, iframe').remove();
  const root = selector ? $(selector) : $('body').length ? $('body') : $.root();
  if (selector && root.length === 0) {
    return { ok: false, error: `Seletor não encontrado: ${selector}`, text: '', matchCount: 0 };
  }
  const text = root
    .text()
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    ok: true,
    matchCount: selector ? root.length : 1,
    text: text.slice(0, 1200),
    chars: text.length,
  };
}

export async function fetchSelectorSample(url, selector) {
  const res = await fetchResponse(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const html = await decodeResponseBody(res);
  return sampleWithSelector(html, (selector || '').trim());
}

export { formatFetchError };
