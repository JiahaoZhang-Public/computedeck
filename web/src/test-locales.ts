// Unit tests use synchronous translations in both languages. Browser tests exercise cold loads.
import { loadLocale } from './i18n';

await Promise.all([loadLocale('en'), loadLocale('zh-CN')]);

// jsdom has no top layer or media-query engine. Browser tests cover inert and geometry.
if (typeof window !== 'undefined') {
  if (!window.matchMedia)
    window.matchMedia = (media: string) => ({
      media,
      matches: false,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return true;
      },
    });
  if (!globalThis.ResizeObserver)
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
  }
}
