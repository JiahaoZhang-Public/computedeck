import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import './display.css';

export function CopyButton({ text, example = false }: { text: string; example?: boolean }) {
  const [result, setResult] = useState<'copied' | 'error' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  async function copy() {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(example ? `${text}\n# example data` : text);
      if (!mounted.current) return;
      setResult('copied');
      timer.current = setTimeout(() => setResult(null), 2000);
    } catch {
      if (mounted.current) setResult('error');
    }
  }
  return (
    <span className="display-copy">
      <button type="button" className="button" onClick={() => void copy()}>
        {t('display.copies')} <code>{text}</code> · {t('display.runsNothing')}
      </button>
      <span role="status">
        {result === 'copied' ? t('display.copied') : result === 'error' ? t('toast.clipboard') : ''}
      </span>
    </span>
  );
}
