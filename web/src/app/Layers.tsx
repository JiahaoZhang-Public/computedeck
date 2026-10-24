import { Suspense } from 'react';
import { lazyView } from './lazyView';
import { Check, TriangleAlert, X } from 'lucide-react';
import type { DeckEvent, Instance, Job, Source, SSHConfig } from '../types';
import type { SourcePreset } from '../forms';
import type { Ctx } from '../pages/shared';
import type { computeHealth } from '../health';
import { HealthPanel } from '../HealthPanel';
import { SourceDiagnosis } from '../SourceDiagnosis';
import { ArrayDetail, InstanceDetail, JobDetail, SSHConfigView } from '../pages/Details';
import { Status } from '../ui';
import { useDialogFocus } from '../useDialogFocus';
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
  | { kind: 'instance'; item?: Instance }
  | { kind: 'source'; source?: Source; preset?: SourcePreset }
  | { kind: 'diagnosis'; sourceId: string }
  | { kind: 'ssh'; data: SSHConfig }
  | null;
export type Detail =
  | { kind: 'job'; item: Job; event?: DeckEvent }
  | { kind: 'instance'; item: Instance }
  | { kind: 'array'; item: { id: string; name: string; jobs: Job[] } }
  | null;
export type Toast = { text: string; tone: 'ok' | 'error' } | null;

export function Layers({
  ctx,
  modal,
  setModal,
  detail,
  setDetail,
  detailId,
  closeDetail,
  eventId,
  eventLoad,
  toast,
  setToast,
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
  setDetail: (detail: Detail) => void;
  detailId: string | null;
  closeDetail: () => void;
  eventId: string | null;
  eventLoad: 'loading' | 'error' | 'done';
  toast: Toast;
  setToast: (toast: Toast) => void;
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
  const detailCtx = data ? { ...ctx, data } : null;
  const diagnosisSource =
    modal?.kind === 'diagnosis'
      ? data?.sources.find((source) => source.id === modal.sourceId)
      : undefined;
  const modalRef = useDialogFocus(undefined, !!modal);
  const detailRef = useDialogFocus(undefined, !!detailId);
  return (
    <>
      {toast && (
        <div className={`toast ${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
          {toast.tone === 'error' ? <TriangleAlert size={15} /> : <Check size={15} />}
          <span>{toast.text}</span>
          <button
            className="icon-button"
            aria-label={t('common.dismiss')}
            onClick={() => setToast(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}
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
      {modal && (
        <div className="overlay" onMouseDown={() => setModal(null)}>
          <section
            className={`modal ${modal.kind === 'ssh' ? 'wide' : ''}`}
            ref={modalRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              className="icon-button modal-close"
              aria-label={t('common.close')}
              onClick={() => setModal(null)}
            >
              <X size={16} />
            </button>
            {modal.kind === 'diagnosis' &&
              (diagnosisSource ? (
                <SourceDiagnosis
                  key={diagnosisSource.id}
                  source={diagnosisSource}
                  configure={() => configure(diagnosisSource)}
                  collect={() => collect(diagnosisSource)}
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
                        modal.item
                          ? `/instances/${encodeURIComponent(modal.item.id)}`
                          : '/instances',
                        body,
                        modal.item ? 'PUT' : 'POST',
                      );
                      setModal(null);
                      setDetail(null);
                      notify(
                        remote
                          ? t('toast.savedRemote', { server: serverName })
                          : t('toast.savedSsh'),
                      );
                      navigate('cloud');
                    }}
                  />
                )}
                {modal.kind === 'source' && (
                  <SourceForm
                    source={modal.source}
                    preset={modal.preset}
                    drivers={drivers}
                    nodes={nodes}
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
          </section>
        </div>
      )}
      {detailId && !detail && detailCtx && (
        <div className="drawer-overlay" onMouseDown={closeDetail}>
          <aside
            className="drawer"
            ref={detailRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="detail-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="detail-title">
              {t(eventId && eventLoad === 'loading' ? 'chart.loading' : 'drawer.unavailable')}
            </h2>
            <p>
              {t(eventId && eventLoad === 'error' ? 'event.loadError' : 'drawer.unavailableHint')}
            </p>
            <button className="button" onClick={closeDetail}>
              {t('common.close')}
            </button>
          </aside>
        </div>
      )}
      {detail && detailCtx && (
        <div className="drawer-overlay" onMouseDown={closeDetail}>
          <aside
            className="drawer"
            ref={detailRef}
            tabIndex={-1}
            role="dialog"
            aria-modal={!modal}
            aria-labelledby="detail-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="drawer-header">
              <div>
                <span className="drawer-kind">
                  {detail.kind === 'job'
                    ? t('drawer.job')
                    : detail.kind === 'array'
                      ? t('drawer.array')
                      : t('drawer.instance')}
                </span>
                <h2 id="detail-title">{detail.item.name}</h2>
                {detail.kind !== 'array' && <Status state={detail.item.state} />}
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
                    setDetail(null);
                    notify(t('toast.instanceRemoved', { name: detail.item.name }));
                  } catch (reason) {
                    notify(errorText(reason, 'error.save'), 'error');
                  }
                }}
              />
            )}
          </aside>
        </div>
      )}
    </>
  );
}
