import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { t } from './i18n';
import { Empty, Panel } from './ui';

interface Props {
  page: string;
  children: ReactNode;
}

/** A page that fails to render shows an error in its place; the menu and other pages work. */
export class PageBoundary extends Component<Props, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(previous: Props) {
    if (previous.page !== this.props.page && this.state.error) this.setState({ error: null });
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Panel>
        <Empty
          title={t('page.failed')}
          text={t('page.failedHint')}
          action={
            <button className="button" onClick={() => this.setState({ error: null })}>
              {t('common.retry')}
            </button>
          }
        />
      </Panel>
    );
  }
}
