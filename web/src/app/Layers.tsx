import { Suspense } from 'react';
import { lazyView } from './lazyView';
import { X } from 'lucide-react';
import type { DeckEvent, Instance, Job, Source, SSHConfig } from '../types';
import type { SourcePreset } from '../forms';
import type { Ctx } from '../pages/shared';
import { snoozeItems } from '../pages/snooze';
import { groupLabel } from '../groups';
import type { computeHealth } from '../health';
import { HealthPanel } from '../HealthPanel';
import { SourceDiagnosis } from '../SourceDiagnosis';
import { ArrayDetail, InstanceDetail, JobDetail, SSHConfigView } from '../pages/Details';
import { Status } from '../ui';
import { ContextPanel, FocusView } from '../layers/Surface';
import { routeParams } from '../useRouteParam';
import { replaceLayer, detailValues, stepVisibleDetail } from '../layers/routes';
import { where } from '../pages/util';
import { errorText, t } from '../i18n';
import { api } from '../api';
import { PageBoundary } from '../PageBoundary';
import { Loading } from './LoadState';

const InstanceForm = lazyView(
  async () => ({ default: (await import('../forms')).InstanceForm }),
  'modal-title',
);
const SourceForm = lazyView(
  async () => ({ default: (await import('../forms')).SourceForm }),
  'modal-title',
);

export type Modal =
  | { kind: 'missing' }
  | { kind: 'instance'; item?: Instance }
  | { kind: 'source'; source?: Source; preset?: SourcePreset }
  | { kind: 'diagnosis'; sourceId: string; reading?: boolean }
  | { kind: 'ssh'; data: SSHConfig }
  | null;
export type Detail =
  | { kind: 'job'; item: Job; event?: DeckEvent }
  | { kind: 'instance'; item: Instance }
  | { kind: 'array'; item: { id: string; name: string; jobs: Job[] } }
  | null;

export function Layers({
  ctx,
  modal,
  setModal,
  detail,
  detailId,
  closeDetail,
  eventId,
  eventLoad,
  healthOpen,
  setHealthOpen,
  healthState,
  needsToken,
  refreshing,
  refresh,
  mutate,
  followCollection,
}: {
  ctx: Omit<Ctx, 'data'> & { data: Ctx['data'] | null };
  modal: Modal;
  setModal: (modal: Modal) => void;
  detail: Detail;
  detailId: string | null;
  closeDetail: () => void;
  eventId: string | null;
  eventLoad: 'loading' | 'error' | 'done';
  healthOpen: boolean;
  setHealthOpen: (open: boolean) => void;
  healthState: ReturnType<typeof computeHealth>;
  needsToken: boolean;
  refreshing: boolean;
  refresh: () => Promise<void>;
  mutate: <T>(path: string, body: unknown, method?: string) => Promise<T>;
  followCollection: (ids?: string[] | null) => void;
}) {
  const {
    data,
    demo,
    busy,
    remote,
    serverName,
    drivers,
    nodes,
    groups,
    configure,
    collect,
    notify,
    navigate,
  } = ctx;
  const params = routeParams();
  const returnToRow = () =>
    [...document.querySelectorAll<HTMLElement>('main [data-detail-key]')].find(
      (row) => params.get(row.dataset.detailKey!) === row.dataset.detailId,
    ) ?? null;
  const detailCtx = data ? { ...ctx, data } : null;
  const diagnosisSource =
    modal?.kind === 'diagnosis'
      ? data?.sources.find((source) => source.id === modal.sourceId)
      : undefined;
  const ModalHost = modal?.kind === 'diagnosis' && modal.reading ? ContextPanel : FocusView;
  return (
    <>
      {healthOpen && (
        <HealthPanel
          state={healthState}
          data={needsToken ? null : data}
          busy={refreshing || needsToken}
          refresh={refresh}
          close={() => setHealthOpen(false)}
          addSource={
            !demo && !needsToken && data && data.sources.length === 0
              ? () => {
                  setHealthOpen(false);
                  configure();
                }
              : undefined
          }
        />
      )}
      {detailId && !detail && detailCtx && (
        <ContextPanel labelledBy="detail-title" close={closeDetail}>
          <h2 id="detail-title">
            {t(eventId && eventLoad === 'loading' ? 'chart.loading' : 'drawer.unavailable')}
          </h2>
          <p>
            {t(eventId && eventLoad === 'error' ? 'event.loadError' : 'drawer.unavailableHint')}
          </p>
          <button className="button" onClick={closeDetail}>
            {t('common.close')}
          </button>
        </ContextPanel>
      )}
      {detail && detailCtx && (
        <ContextPanel
          labelledBy="detail-title"
          close={closeDetail}
          onStep={stepVisibleDetail}
          returnFocus={returnToRow}
        >
          <header className="drawer-header">
            <div>
              {/* Breadcrumb: where the item lives; then the name with its state; then its ids. */}
              <span className="drawer-kind">
                {detail.kind === 'instance' ? t('nav.cloud') : t('nav.jobs')}
                <span aria-hidden="true"> ›</span>
              </span>
              <div className="drawer-title">
                <h2 id="detail-title">{detail.item.name}</h2>
                {detail.kind !== 'array' && <Status state={detail.item.state} />}
              </div>
              <div className="drawer-chips">
                {(() => {
                  const id =
                    detail.kind === 'array'
                      ? `${t('drawer.array')} · ${detail.item.id}`
                      : detail.item.id;
                  // Each chip stays on one line; the full value is its tooltip and in Details.
                  return (
                    <code className="drawer-id" title={id}>
                      {id}
                    </code>
                  );
                })()}
                {/* The scheduler's own code, beside the id it belongs to. */}
                {detail.kind === 'job' &&
                  detail.item.reason &&
                  !/^none$/i.test(detail.item.reason) && (
                    <code className="drawer-code" title={detail.item.reason}>
                      {detail.item.reason}
                    </code>
                  )}
              </div>
            </div>
            <button className="icon-button" aria-label={t('common.close')} onClick={closeDetail}>
              <X size={16} />
            </button>
          </header>
          {detail.kind === 'array' ? (
            <ArrayDetail key={detail.item.id} jobs={detail.item.jobs} ctx={detailCtx} />
          ) : detail.kind === 'job' ? (
            <JobDetail job={detail.item} ctx={detailCtx} event={detail.event} />
          ) : (
            <InstanceDetail
              item={detail.item}
              ctx={detailCtx}
              onProbe={async () => {
                try {
                  await mutate<Instance>(
                    `/instances/${encodeURIComponent(detail.item.id)}/probe`,
                    {},
                  );
                  notify(t('toast.probed'));
                } catch (reason) {
                  notify(errorText(reason, 'error.probe'), 'error');
                }
              }}
              onEdit={() => setModal({ kind: 'instance', item: detail.item })}
              onDelete={async () => {
                try {
                  await mutate(`/instances/${encodeURIComponent(detail.item.id)}`, {}, 'DELETE');
                  closeDetail();
                  notify(t('toast.instanceRemoved', { name: detail.item.name }));
                } catch (reason) {
                  notify(errorText(reason, 'error.save'), 'error');
                }
              }}
            />
          )}
        </ContextPanel>
      )}
      {modal && (
        <ModalHost
          className={modal.kind === 'ssh' ? 'wide' : ''}
          labelledBy="modal-title"
          close={() => setModal(null)}
          initial={ModalHost === FocusView ? '.modal-close' : undefined}
        >
          {/* A source's detail draws its own header, close button included. */}
          {!(modal.kind === 'diagnosis' && diagnosisSource) && (
            <button
              className="icon-button modal-close"
              aria-label={t('common.close')}
              onClick={() => setModal(null)}
            >
              <X size={16} />
            </button>
          )}
          {modal.kind === 'missing' && <h2 id="modal-title">{t('drawer.unavailable')}</h2>}
          {modal.kind === 'diagnosis' &&
            (diagnosisSource ? (
              <SourceDiagnosis
                key={diagnosisSource.id}
                source={diagnosisSource}
                configure={() => configure(diagnosisSource)}
                addLogin={
                  diagnosisSource.kind === 'cluster'
                    ? () =>
                        configure(undefined, {
                          driver: diagnosisSource.driver,
                          clusterName: groupLabel(ctx.groups, diagnosisSource.cluster_id),
                        })
                    : undefined
                }
                remove={async () => {
                  try {
                    await mutate(
                      `/sources/${encodeURIComponent(diagnosisSource.id)}`,
                      {},
                      'DELETE',
                    );
                    setModal(null);
                    notify(t('toast.sourceRemoved', { name: diagnosisSource.name }));
                  } catch (reason) {
                    notify(errorText(reason, 'error.save'), 'error');
                  }
                }}
                collect={() => collect(diagnosisSource)}
                pause={() => ctx.pauseSource(diagnosisSource)}
                snooze={snoozeItems(ctx, diagnosisSource.id)}
                nodes={ctx.nodes}
                close={() => setModal(null)}
                collecting={data?.collecting?.includes(diagnosisSource.id)}
                demo={demo}
                drivers={drivers}
              />
            ) : (
              <h2 id="modal-title">{t('msg.source_not_found')}</h2>
            ))}
          <PageBoundary page={modal.kind}>
            <Suspense fallback={<Loading id="modal-title" />}>
              {modal.kind === 'instance' && (
                <InstanceForm
                  key={modal.item?.id ?? 'new-instance'}
                  item={modal.item}
                  platforms={[
                    ...new Set(
                      (data?.instances ?? [])
                        .filter((item) => item.manual)
                        .map((item) => item.platform),
                    ),
                  ]}
                  where={where({ remote, serverName })}
                  busy={busy}
                  onCancel={() => setModal(null)}
                  onSubmit={async (body) => {
                    await mutate(
                      modal.item ? `/instances/${encodeURIComponent(modal.item.id)}` : '/instances',
                      body,
                      modal.item ? 'PUT' : 'POST',
                    );
                    replaceLayer({
                      ...detailValues(),
                      add: null,
                      edit: null,
                      repair: null,
                      step: null,
                      instance: null,
                    });
                    notify(
                      remote ? t('toast.savedRemote', { server: serverName }) : t('toast.savedSsh'),
                    );
                    navigate('cloud');
                  }}
                />
              )}
              {modal.kind === 'source' && (
                <SourceForm
                  key={modal.source?.id ?? 'new-source'}
                  source={modal.source}
                  preset={modal.preset}
                  drivers={drivers}
                  nodes={nodes}
                  demo={demo}
                  sources={data?.sources ?? []}
                  groups={groups}
                  where={where({ remote, serverName })}
                  busy={busy}
                  onCancel={() => setModal(null)}
                  onManual={() => setModal({ kind: 'instance' })}
                  onDelete={async (source) => {
                    await mutate(`/sources/${encodeURIComponent(source.id)}`, {}, 'DELETE');
                    setModal(null);
                    notify(t('toast.sourceRemoved', { name: source.name }));
                  }}
                  onSubmit={async (body, id) => {
                    const saved = await mutate<Source>(
                      id ? `/sources/${encodeURIComponent(id)}` : '/sources',
                      body,
                      id ? 'PUT' : 'POST',
                    );
                    if (saved.enabled) {
                      await api('/refresh', { source_id: saved.id });
                      followCollection([saved.id]);
                    }
                    if (modal.source) notify(t('toast.sourceSaved'));
                    return saved;
                  }}
                />
              )}
            </Suspense>
          </PageBoundary>
          {modal.kind === 'ssh' && (
            <SSHConfigView
              config={modal.data}
              remote={remote}
              serverName={serverName}
              busy={busy}
              onInstall={async () => {
                try {
                  await mutate('/ssh/install', { confirm: true });
                  setModal({ kind: 'ssh', data: await api<SSHConfig>('/ssh/config') });
                  notify(t('toast.includeInstalled'));
                } catch (reason) {
                  notify(errorText(reason, 'error.sshConfig'), 'error');
                }
              }}
            />
          )}
        </ModalHost>
      )}
    </>
  );
}
