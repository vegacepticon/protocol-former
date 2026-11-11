// src/i18n/i18n-service.ts
// Phase 84 (I18N-01) — type-safe i18n layer.

import en from './locales/en.json';
import ru from './locales/ru.json';

type Locale = 'en' | 'ru';

const LOCALE_MAP: Record<Locale, Record<string, unknown>> = {
  en: en as Record<string, unknown>,
  ru: ru as Record<string, unknown>,
};

function getNested(obj: Record<string, unknown>, path: string): string | undefined {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : undefined;
}

export class I18nService {
  private locale: Locale;

  constructor(locale: Locale = 'en') {
    this.locale = locale;
  }

  setLocale(locale: Locale): void {
    this.locale = locale;
  }

  getLocale(): Locale {
    return this.locale;
  }

  t(key: string, params?: Record<string, string>, fallback?: string): string {
    const messages = LOCALE_MAP[this.locale];
    let text = getNested(messages, key);
    if (text === undefined) {
      // fallback to English
      text = getNested(LOCALE_MAP.en, key);
    }
    if (text === undefined) {
      text = fallback ?? key;
    }
    if (params) {
      text = text.replace(/\{(\w+)\}/g, (_match, paramKey) => {
        return params[paramKey] ?? `{${paramKey}}`;
      });
    }
    return text;
  }
}
