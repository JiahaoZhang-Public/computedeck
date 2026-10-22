import en from './locales/en';
import zhCN from './locales/zh-CN';

export type Locale = 'en' | 'zh-CN';
export type MessageKey = keyof typeof en;
export type Params = Record<string, string | number | null | undefined>;
/** A server notice: `code` is translated as `msg.<code>`; `detail` is untranslated remote text. */
export type Message = { code: string; detail?: string | null; [param: string]: unknown };

export const locales: { value: Locale; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'zh-CN', label: '中文' },
];
const dictionaries: Record<Locale, Record<MessageKey, string>> = { en, 'zh-CN': zhCN };
const STORAGE_KEY = 'computedeck.locale';
let current: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'zh-CN';
}

/** The viewer's own choice on this device, if any. */
export function storedLocale(): Locale | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

export function storeLocale(locale: Locale) {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* Private windows may block storage; the choice then lasts for this page only. */
  }
}

export function setLocale(locale: Locale) {
  current = locale;
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

export function locale(): Locale {
  return current;
}

const han = /[\u3400-\u9fff\uf900-\ufaff]/;
const latinStart = /^[A-Za-z0-9]/;
const latinEnd = /[A-Za-z0-9.]$/;

function fill(template: string, params?: Params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string, at: number) => {
    if (params[name] == null) return match;
    const value = String(params[name]);
    // Chinese text puts a space between Han characters and a Latin name or number.
    const before = han.test(template[at - 1] ?? '') && latinStart.test(value) ? ' ' : '';
    const after = han.test(template[at + match.length] ?? '') && latinEnd.test(value) ? ' ' : '';
    return before + value + after;
  });
}

export function t(key: MessageKey, params?: Params): string {
  // A `<key>.one` variant, where present, is used for a count of exactly 1.
  const one = `${key}.one`;
  const chosen = params?.count === 1 && one in en ? (one as MessageKey) : key;
  return fill(dictionaries[current][chosen] ?? en[chosen], params);
}

/** Text a driver or plugin supplies in several languages; English is the fallback. */
export function localized(text: Record<string, string> | undefined, params?: Params): string {
  if (!text) return '';
  return fill(text[current] ?? text.en ?? '', params);
}

export function hasKey(key: string): key is MessageKey {
  return key in en;
}

/** Compact low-use duration, rounded down and omitting zero parts. */
export function lowUseDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = Math.floor(minutes % 60);
  return [
    hours ? t('lowUse.duration.hours', { count: hours }) : '',
    remainder || !hours ? t('lowUse.duration.minutes', { count: remainder }) : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Render a server message (or a legacy plain string) in the current language. */
export function formatMessage(value: Message | string | null | undefined): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  const key = `msg.${value.code}`;
  const params: Params = {};
  for (const [name, param] of Object.entries(value))
    if (typeof param === 'string' || typeof param === 'number') params[name] = param;
  if (value.code === 'attention_instance_low_use' || value.code === 'instance_low_use') {
    params.duration = lowUseDuration(Number(value.minutes));
    params.origin_note = value.origin === 'provider' ? ` · ${t('lowUse.provider')}` : '';
    params.cost_note = '';
    if (typeof value.cost === 'number' && typeof value.currency === 'string') {
      let cost: string;
      try {
        cost = new Intl.NumberFormat(current, {
          style: 'currency',
          currency: value.currency,
        }).format(value.cost);
      } catch {
        cost = `${value.cost.toFixed(2)} ${value.currency}`;
      }
      params.cost_note = t('lowUse.cost', { cost });
    }
  }
  const text = hasKey(key) ? t(key, params) : value.code;
  return value.detail && !text.includes(value.detail) ? `${text}: ${value.detail}` : text;
}

/** Errors thrown by `api()` carry the server message so it can be re-rendered. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: Message | string | null,
  ) {
    super(typeof detail === 'string' ? detail : (detail?.code ?? `HTTP ${status}`));
  }
}

export function errorText(reason: unknown, fallback: MessageKey): string {
  if (reason instanceof ApiError)
    return formatMessage(reason.detail) || t('error.http', { status: reason.status });
  if (reason instanceof Error && reason.message) return reason.message;
  return t(fallback);
}
