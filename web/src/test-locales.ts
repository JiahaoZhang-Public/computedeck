// Unit tests use synchronous translations in both languages. Browser tests exercise cold loads.
import { loadLocale } from './i18n';

await Promise.all([loadLocale('en'), loadLocale('zh-CN')]);
