// CI-only build-time fixtures. The real scaffolded hello bundle registers through WEB_API 1.
import { useEffect } from 'react';
import { Circle } from 'lucide-react';
import { Panel } from '../src/ui';
import type { WebPlugin } from '../src/plugins';

export default [
  {
    id: 'fixture-null',
    overview: () => null,
    banner: function LoadHello() {
      useEffect(() => {
        void import('computedeck:hello');
      }, []);
      return null;
    },
  },
  {
    id: 'fixture-page-only',
    pages: [
      {
        id: 'fixture-page-only',
        label: { en: 'Page only', 'zh-CN': '独立页面' },
        icon: Circle,
        render: ({ locale }) => (
          <Panel title={locale === 'zh-CN' ? '独立页面' : 'Page only'}>
            <p className="panel-note">{locale === 'zh-CN' ? '没有插槽' : 'No slots'}</p>
          </Panel>
        ),
      },
    ],
  },
] satisfies WebPlugin[];
