const STATUS_LABELS = {
  available: 'disponível',
  reserved: 'reservada',
  paid: 'paga',
  canceled: 'cancelada',
  cancelled: 'cancelada',
  ativa: 'ativa',
  inativa: 'inativa',
};

const FIELD_LABELS = {
  status: 'Status',
  name: 'Nome',
  churchName: 'Igreja',
  departmentName: 'Departamento',
  drawDate: 'Data do sorteio',
  pricePerQuota: 'Valor da cota',
  quotaCount: 'Total de cotas',
  pixKey: 'Chave PIX',
  holderFirstName: 'Nome',
  holderLastName: 'Sobrenome',
  firstName: 'Nome',
  lastName: 'Sobrenome',
  number: 'Número',
  quotaNumbers: 'Cotas',
  totalAmount: 'Valor total',
  expiresAtMs: 'Expira em',
  alreadyDrawn: 'Já sorteada',
  winner: 'Ganhador',
  publicCode: 'Código público',
};

function labelOf(key) {
  return FIELD_LABELS[key] || key;
}

function formatValue(key, value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'sim' : 'não';
  if (key === 'status' && STATUS_LABELS[value]) return STATUS_LABELS[value];
  if (key === 'expiresAtMs' && typeof value === 'number') {
    try {
      return new Intl.DateTimeFormat('pt-BR', {
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date(value));
    } catch {
      return String(value);
    }
  }
  if (key === 'drawDate' && typeof value === 'string') {
    const [y, m, d] = value.split('-');
    if (y && m && d) return `${d}/${m}/${y}`;
  }
  if (Array.isArray(value)) {
    if (value.every((n) => typeof n === 'number' || /^\d+$/.test(String(n)))) {
      return value.join(', ');
    }
    return `${value.length} item(ns)`;
  }
  if (typeof value === 'object') {
    if (value.firstName || value.lastName || value.name) {
      return [value.firstName || value.name, value.lastName].filter(Boolean).join(' ').trim() || '—';
    }
    return 'dados atualizados';
  }
  return String(value);
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function personName(obj = {}) {
  const full = [obj.holderFirstName || obj.firstName, obj.holderLastName || obj.lastName]
    .filter(Boolean)
    .join(' ')
    .trim();
  return full || '—';
}

function diffObjectFields(before, after, keys) {
  const items = [];
  for (const key of keys) {
    if (same(before?.[key], after?.[key])) continue;
    items.push({
      label: labelOf(key),
      from: formatValue(key, before?.[key]),
      to: formatValue(key, after?.[key]),
    });
  }
  return items;
}

function indexQuotas(data) {
  const map = new Map();
  const list = Array.isArray(data?.quotas) ? data.quotas : [];
  for (const q of list) {
    const num = Number(q.number);
    if (!Number.isNaN(num)) map.set(num, q);
  }
  return map;
}

function diffQuotas(before, after) {
  const groups = [];
  const a = indexQuotas(before);
  const b = indexQuotas(after);
  const numbers = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x - y);

  for (const num of numbers) {
    const prev = a.get(num);
    const next = b.get(num);
    if (same(prev, next)) continue;

    const items = [];
    if (!prev && next) {
      items.push({ label: 'Situação', from: '—', to: 'nova cota / atualizada' });
    } else if (prev && !next) {
      items.push({ label: 'Situação', from: 'existente', to: 'removida' });
    } else {
      items.push(...diffObjectFields(prev, next, ['status', 'expiresAtMs']));
      const prevName = personName(prev);
      const nextName = personName(next);
      if (prevName !== nextName) {
        items.push({ label: 'Titular', from: prevName, to: nextName });
      }
    }

    if (items.length) {
      groups.push({
        title: `Cota ${num}`,
        items,
      });
    }
  }
  return groups;
}

function indexReservations(data) {
  const map = new Map();
  const list = Array.isArray(data?.reservations) ? data.reservations : [];
  for (const r of list) {
    const id = String(r.reservationId || `${r.firstName}-${r.lastName}-${(r.quotaNumbers || []).join(',')}`);
    map.set(id, r);
  }
  return map;
}

function diffReservations(before, after) {
  const groups = [];
  const a = indexReservations(before);
  const b = indexReservations(after);
  const ids = [...new Set([...a.keys(), ...b.keys()])];

  for (const id of ids) {
    const prev = a.get(id);
    const next = b.get(id);
    if (same(prev, next)) continue;

    const name = personName(next || prev);
    const title = name !== '—' ? `Reserva · ${name}` : 'Reserva';

    if (!prev && next) {
      groups.push({
        title,
        items: [
          { label: 'Situação', from: '—', to: 'nova reserva' },
          { label: 'Status', from: '—', to: formatValue('status', next.status) },
          { label: 'Cotas', from: '—', to: formatValue('quotaNumbers', next.quotaNumbers) },
        ],
      });
      continue;
    }
    if (prev && !next) {
      groups.push({
        title: `Reserva · ${personName(prev)}`,
        items: [{ label: 'Situação', from: 'ativa', to: 'removida' }],
      });
      continue;
    }

    const items = diffObjectFields(prev, next, [
      'status',
      'firstName',
      'lastName',
      'quotaNumbers',
      'totalAmount',
      'expiresAtMs',
    ]);
    if (items.length) groups.push({ title, items });
  }
  return groups;
}

function diffGeneric(before, after, path = '') {
  const groups = [];
  if (same(before, after)) return groups;

  if (Array.isArray(before) || Array.isArray(after)) {
    groups.push({
      title: path || 'Lista',
      items: [
        {
          label: 'Quantidade',
          from: Array.isArray(before) ? String(before.length) : '—',
          to: Array.isArray(after) ? String(after.length) : '—',
        },
      ],
    });
    return groups;
  }

  if (
    (before && typeof before === 'object') ||
    (after && typeof after === 'object')
  ) {
    const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].filter(
      (k) => !['_snapshotAt', '_fetchedAt', 'quotas', 'reservations'].includes(k)
    );
    const items = [];
    for (const key of keys) {
      const prev = before?.[key];
      const next = after?.[key];
      if (same(prev, next)) continue;
      if (prev && next && typeof prev === 'object' && typeof next === 'object' && !Array.isArray(prev)) {
        groups.push(...diffGeneric(prev, next, labelOf(key)));
      } else {
        items.push({
          label: labelOf(key),
          from: formatValue(key, prev),
          to: formatValue(key, next),
        });
      }
    }
    if (items.length) {
      groups.push({ title: path || 'Informações gerais', items });
    }
    return groups;
  }

  groups.push({
    title: path || 'Conteúdo',
    items: [
      {
        label: 'Valor',
        from: formatValue('', before),
        to: formatValue('', after),
      },
    ],
  });
  return groups;
}

function rebuildFromUnifiedDiff(diffText) {
  const beforeLines = [];
  const afterLines = [];
  for (const raw of String(diffText || '').split('\n')) {
    if (
      raw.startsWith('---') ||
      raw.startsWith('+++') ||
      raw.startsWith('@@') ||
      raw.startsWith('Index:') ||
      raw.startsWith('=====')
    ) {
      continue;
    }
    if (raw.startsWith('-')) beforeLines.push(raw.slice(1));
    else if (raw.startsWith('+')) afterLines.push(raw.slice(1));
    else {
      const text = raw.startsWith(' ') ? raw.slice(1) : raw;
      beforeLines.push(text);
      afterLines.push(text);
    }
  }
  return {
    beforeText: beforeLines.join('\n'),
    afterText: afterLines.join('\n'),
  };
}

function extractJsonObjects(text) {
  const objects = [];
  const src = String(text || '');
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '{') continue;
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') depth += 1;
      if (src[j] === '}') depth -= 1;
      if (depth === 0) {
        const slice = src.slice(i, j + 1);
        try {
          objects.push(JSON.parse(slice));
        } catch {
          /* ignore incomplete fragments */
        }
        i = j;
        break;
      }
    }
  }
  return objects;
}

function describeQuotaLike(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const number = obj.number ?? obj.quotaNumber;
  const status = obj.status;
  const name = personName(obj);
  if (number == null && !status && name === '—') return null;
  const parts = [];
  if (number != null) parts.push(`Cota ${number}`);
  if (status) parts.push(formatValue('status', status));
  if (name !== '—') parts.push(name);
  if (obj.expiresAtMs) parts.push(`expira ${formatValue('expiresAtMs', obj.expiresAtMs)}`);
  return parts.join(' · ');
}

function describeReservationLike(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (!obj.reservationId && !obj.quotaNumbers && !obj.firstName) return null;
  const parts = [`Reserva · ${personName(obj)}`];
  if (obj.status) parts.push(formatValue('status', obj.status));
  if (obj.quotaNumbers) parts.push(`cotas ${formatValue('quotaNumbers', obj.quotaNumbers)}`);
  return parts.join(' · ');
}

function humanLinesFromText(text) {
  const objects = extractJsonObjects(text);
  const lines = [];
  for (const obj of objects) {
    const quota = describeQuotaLike(obj);
    const reservation = describeReservationLike(obj);
    if (quota) lines.push(quota);
    else if (reservation) lines.push(reservation);
    else {
      const keys = Object.keys(obj).filter((k) => !VOLATILE_SKIP.has(k)).slice(0, 6);
      if (!keys.length) continue;
      lines.push(
        keys
          .map((k) => `${labelOf(k)}: ${formatValue(k, obj[k])}`)
          .join(' · ')
      );
    }
  }
  if (lines.length) return [...new Set(lines)];

  const plain = String(text || '')
    .replace(/[{}\[\]",]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return [];
  // never return raw code-looking dumps
  if (/expiresAtMs|holderFirstName|quotaNumbers/.test(plain)) {
    return ['Alteração nos dados da página (detalhe indisponível nesta captura)'];
  }
  return [plain.slice(0, 400)];
}

const VOLATILE_SKIP = new Set(['_snapshotAt', '_fetchedAt']);

function textChanges(beforeText, afterText) {
  const beforeLines = humanLinesFromText(beforeText);
  const afterLines = humanLinesFromText(afterText);
  if (!beforeLines.length && !afterLines.length) return [];

  const max = Math.max(beforeLines.length, afterLines.length, 1);
  const groups = [];
  for (let i = 0; i < max; i++) {
    const from = beforeLines[i] || '—';
    const to = afterLines[i] || '—';
    if (from === to) continue;
    groups.push({
      title: beforeLines.length + afterLines.length > 1 ? `Alteração ${i + 1}` : 'O que mudou',
      items: [
        { label: 'Antes', from, to: null },
        { label: 'Depois', from: null, to },
      ],
    });
  }
  return groups.slice(0, 40);
}

export function buildHumanChanges(beforeText, afterText) {
  try {
    const before = JSON.parse(beforeText);
    const after = JSON.parse(afterText);
    const groups = [
      ...diffGeneric(before, after),
      ...diffQuotas(before, after),
      ...diffReservations(before, after),
    ];
    return groups.slice(0, 40);
  } catch {
    return textChanges(beforeText, afterText);
  }
}

export function changesFromDiffText(diffText) {
  const { beforeText, afterText } = rebuildFromUnifiedDiff(diffText);
  return buildHumanChanges(beforeText, afterText);
}
