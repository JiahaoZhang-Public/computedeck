import { t } from '../i18n';
import { useCopy, type CopyKind } from '../copy';
import './display.css';

export function CopyButton({ text, kind = 'command' }: { text: string; kind?: CopyKind }) {
  const copy = useCopy();
  return (
    <span className="display-copy">
      <button type="button" className="button" onClick={() => void copy?.(text, { kind })}>
        {t('display.copies')} <code lang="en">{text}</code> · {t('display.runsNothing')}
      </button>
    </span>
  );
}
