import { Suspense } from 'react';
import { lazyView } from './lazyView';
import type { ComponentType } from 'react';
import type { Ctx } from '../pages/shared';
import type { CorePage, Page } from '../routes';
import { Loading } from './LoadState';
import { OverviewPage } from '../pages/Overview';
import { ActivityPage } from '../pages/Activity';
import { JobsPage } from '../pages/Jobs';
import { CloudPage } from '../pages/Cloud';
import { SourcesPage } from '../pages/Sources';
import { ClustersPage } from '../pages/Clusters';

const PlanPage = lazyView(async () => ({ default: (await import('../pages/Plan')).PlanPage }));
const UsagePage = lazyView(async () => ({ default: (await import('../pages/Usage')).UsagePage }));
const ToolboxPage = lazyView(async () => ({
  default: (await import('../pages/Toolbox')).ToolboxPage,
}));
const NotifyPage = lazyView(async () => ({
  default: (await import('../pages/Notify')).NotifyPage,
}));
const ChatPage = lazyView(async () => ({ default: (await import('../pages/Chat')).ChatPage }));
const SettingsPage = lazyView(async () => ({
  default: (await import('../pages/Settings')).SettingsPage,
}));
const Gallery = lazyView(async () => ({ default: (await import('../Gallery')).Gallery }));

const routeTable: Record<CorePage, ComponentType<{ ctx: Ctx }>> = {
  overview: OverviewPage,
  jobs: JobsPage,
  activity: ActivityPage,
  resources: ClustersPage,
  cloud: CloudPage,
  sources: SourcesPage,
  plan: PlanPage,
  usage: UsagePage,
  toolbox: ToolboxPage,
  notify: NotifyPage,
  chat: ChatPage,
  settings: SettingsPage,
};

export function Routes({ page, ctx, compat }: { page: Page; ctx: Ctx; compat: boolean }) {
  const PageComponent = routeTable[page as CorePage] ?? OverviewPage;
  return (
    <Suspense fallback={<Loading />}>
      {page === '__gallery' ? <Gallery compat={compat} /> : <PageComponent ctx={ctx} />}
    </Suspense>
  );
}
