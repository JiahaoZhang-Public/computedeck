import { useState } from 'react';
import { errorText, t } from './i18n';
import { BrandMark } from './ui';

/** Text with `commands` in backticks shown as code. */
function withCode(text: string) {
  return text.split('`').map((part, index) => (index % 2 ? <code key={index}>{part}</code> : part));
}

/** Shown when the service refuses requests without its access token. */
export function TokenGate({
  where,
  rejected,
  onSave,
}: {
  where: string;
  /** A stored session was dropped because this service could not prove it issued it. */
  rejected: boolean;
  onSave: (token: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="panel token-gate">
      <BrandMark size={28} />
      <h2>{t('token.title')}</h2>
      {rejected && (
        <p className="form-error" role="alert">
          {withCode(t('token.unverified'))}
        </p>
      )}
      <p>{withCode(t('token.text', { where }))}</p>
      <pre className="config-preview">computedeck token</pre>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!value.trim()) return;
          setError(null);
          onSave(value.trim()).catch((reason) => setError(errorText(reason, 'error.save')));
        }}
      >
        <input
          aria-label={t('token.label')}
          placeholder={t('token.label')}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button className="button primary" disabled={!value.trim()}>
          {t('token.save')}
        </button>
      </form>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
