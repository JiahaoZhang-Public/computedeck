import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { loadLocale, localeLoaded, startupLocale } from '../i18n';
import { loadingLabels } from '../locales/loading';

/** Do not render a page in the wrong language while its dictionary is in flight. */
export function LocaleGate({ children }: { children: ReactNode }) {
  const [language] = useState(startupLocale);
  const [ready, setReady] = useState(() => localeLoaded(language));
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void loadLocale(language).then(
      () => {
        if (!cancelled) setReady(true);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [language, attempt]);
  if (ready) return children;
  const labels = loadingLabels[language];
  return (
    <div className="loading" lang={language} aria-busy={!failed}>
      {failed ? (
        <>
          <span role="alert">{labels['error.locale']}</span>
          <button
            className="button"
            onClick={() => {
              setFailed(false);
              setAttempt(attempt + 1);
            }}
          >
            {labels['common.retry']}
          </button>
        </>
      ) : (
        <>
          <Loader2 className="spin" size={18} />
          {labels['common.loading']}
        </>
      )}
    </div>
  );
}
