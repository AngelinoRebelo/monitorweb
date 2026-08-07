/**
 * Helpers for SEI public-process captures.
 * Keep captcha widgets from poisoning change detection when protocol tables are present.
 */

export function hasUsefulSeiContent(text) {
  const t = String(text || '');
  if (t.length < 80) return false;

  if (/\[protocolos\]|\[andamentos\]/i.test(t)) {
    const rows = t.split('\n').filter((l) => l.trim() && !/^\[[a-z]+\]$/i.test(l.trim()));
    return rows.length >= 2;
  }

  const hasLists = /lista de protocolos|lista de andamentos/i.test(t);
  const hasSignals =
    /(despacho|of[ií]cio|publica[cç][aã]o|anexo|externo|processo remetido|processo recebido|documento)/i.test(
      t
    );
  return hasLists && hasSignals && t.length >= 200;
}

export function isSeiCaptchaWall(html, text) {
  if (hasUsefulSeiContent(text)) return false;
  const blob = `${html || ''}\n${text || ''}`.toLowerCase();
  const captchaCopy =
    /digite o c[oó]digo da imagem/.test(blob) ||
    /informe o c[oó]digo de confirma[cç][aã]o/.test(blob) ||
    (/txtinfracaptcha/.test(blob) && /imgcaptcha/.test(blob));
  if (!captchaCopy) return false;
  return !/lista de protocolos|lista de andamentos|\[protocolos\]|\[andamentos\]/i.test(text || '');
}

export function isSeiEmptyOrMissing(html, text) {
  const blob = `${html || ''}\n${text || ''}`.toLowerCase();
  if (/processo n[aã]o encontrado/.test(blob)) return true;
  const compact = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return (!compact || compact.length < 60) && !hasUsefulSeiContent(text);
}
