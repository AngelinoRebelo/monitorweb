/** Shared logo preview helpers — temporary until one option is chosen permanently. */
export const LOGO_OPTIONS = [
  {
    id: 'a',
    label: 'A · Radar',
    mark: '/logos/logo-a.svg',
    wordmark: null,
  },
  {
    id: 'b',
    label: 'B · Sinal',
    mark: '/logos/logo-b.svg',
    wordmark: null,
  },
  {
    id: 'c',
    label: 'C · Wordmark',
    mark: '/logos/logo-a.svg',
    wordmark: '/logos/logo-c.svg',
  },
];

const STORAGE_KEY = 'monitorweb-logo-preview';

export function getLogoChoice() {
  const id = localStorage.getItem(STORAGE_KEY) || 'a';
  return LOGO_OPTIONS.find((o) => o.id === id) || LOGO_OPTIONS[0];
}

export function setLogoChoice(id) {
  localStorage.setItem(STORAGE_KEY, id);
  applyLogoChoice(document);
}

export function applyLogoChoice(root = document) {
  const choice = getLogoChoice();
  const useWordmark = Boolean(choice.wordmark);

  root.querySelectorAll('[data-brand-mark]').forEach((el) => {
    el.hidden = useWordmark;
    if (!useWordmark) {
      el.innerHTML = `<img src="${choice.mark}" alt="" width="40" height="40" />`;
      el.classList.add('mark-img');
    }
  });

  root.querySelectorAll('[data-brand-wordmark]').forEach((el) => {
    if (useWordmark) {
      el.hidden = false;
      el.innerHTML = `<img src="${choice.wordmark}" alt="MonitorWeb" class="wordmark-img" />`;
    } else {
      el.hidden = true;
      el.innerHTML = '';
    }
  });

  root.querySelectorAll('[data-brand-text]').forEach((el) => {
    el.hidden = useWordmark;
  });

  root.querySelectorAll('[data-logo-option]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.logoOption === choice.id);
  });

  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon) favicon.href = choice.mark;
}

export function bindLogoPicker(root = document) {
  root.querySelectorAll('[data-logo-option]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setLogoChoice(btn.dataset.logoOption);
    });
  });
  applyLogoChoice(root);
}
