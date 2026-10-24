import { useState } from 'react';
import { formatMessage, t } from '../i18n';
import type { DisplayExample } from '../types';
import { Panel } from '../ui';
import { Status, StatusShape } from './Status';
import { shapes } from './shapes';
import type { StatusKind } from './shapes';
import { Time, Duration, Age } from './Time';
import { Value } from './Value';
import { ScopeLine, HowWorkedOut } from './ScopeLine';
import { Swatch, Monogram } from './Identity';
import { CopyButton } from './CopyButton';
import { DataState } from './DataState';

const kinds = Object.keys(shapes) as StatusKind[];
const command = 'squeue --me --start -j 48213';
export function DisplayGallery({ example }: { example?: DisplayExample }) {
  const [filtered, setFiltered] = useState(true);
  const missing = t('gallery.missing');
  return (
    <>
      <Panel title={t('gallery.shapes')}>
        <div className="shape-gallery">
          {['normal', 'grayscale'].map((mode) => (
            <div className={`shape-samples ${mode}`} key={mode}>
              {mode === 'grayscale' && (
                <h3 className="gallery-caption">{t('gallery.grayscale')}</h3>
              )}
              {[8, 10, 12, 16].map((size) => (
                <div className="gallery-row" key={size} data-size={size}>
                  <span>{size}</span>
                  {kinds.map((kind) => (
                    <span key={kind} className="shape-sample" data-kind={kind}>
                      <StatusShape kind={kind} size={size} /> {t(`display.status.${kind}`)}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="gallery-row">
          {kinds.map((kind) => (
            <Status kind={kind} key={kind} />
          ))}
        </div>
      </Panel>
      <Panel title={t('gallery.identity')}>
        <div className="gallery-row">
          {[1, 2, 3, 4, 5, 6].map((slot) => (
            <span className="shape-sample" key={slot}>
              <Swatch slot={slot} />
              <Monogram slot={slot} label={`${t('nav.clusters')} ${slot}`} />
              {slot}
            </span>
          ))}
        </div>
      </Panel>
      {example && (
        <Panel title={t('gallery.display')}>
          <div className="gallery-stack">
            <ScopeLine
              scope={t('gallery.mine')}
              groups={t('gallery.allClusters')}
              asOf={example.at}
            />
            <div className="gallery-row">
              <Value value={example.known} unit="GPU" />
              <Value value={example.known} unit="GPU" kind="lower" reason={missing} />
              <Value value={example.estimate} kind="estimate" currency="USD" />
              <Value value={null} reason={missing} />
              <Value
                value={example.last_known}
                kind="lastKnown"
                at={example.stale_at}
                reason={missing}
              />
              <Value value={example.last_known} stale reason={missing} />
            </div>
            <div className="gallery-row">
              <Time value={example.at} relative />
              <Duration seconds={example.duration_seconds} table />
              <Duration seconds={example.duration_seconds} />
              <Age label={t('clusters.nodes')} value={example.at} />
              <Age label={t('job.qos')} value={example.qos_at} />
              <Age value={example.stale_at} stale />
            </div>
            <HowWorkedOut trace={example.trace} />
            <div className="gallery-row">
              <CopyButton text={command} example />
            </div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <tbody>
                <tr>
                  <td>
                    <a
                      className="display-row-link"
                      href="#/jobs"
                      aria-describedby="gallery-time-description"
                    >
                      {t('nav.jobs')}
                    </a>
                  </td>
                  <td>
                    <Time value={example.at} descriptionId="gallery-time-description" />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div data-static-sample>
            <DataState state="loading" />
          </div>
          <DataState
            state="first"
            action={
              <a className="button" href="#/sources">
                {t('nav.sources')}
              </a>
            }
            example={
              <a className="link" href="?demo=true#/overview">
                {t('gallery.example')}
              </a>
            }
          />
          <DataState state="quiet" />
          {filtered ? (
            <DataState
              state="filtered"
              hidden={example.hidden}
              onClear={() => setFiltered(false)}
            />
          ) : (
            <button className="button" onClick={() => setFiltered(true)}>
              {t('gallery.filter')}
            </button>
          )}
          <DataState
            state="error"
            reason={formatMessage(example.trace.excluded[0].reason)}
            at={example.stale_at}
          >
            <Value
              value={example.last_known}
              kind="lastKnown"
              at={example.stale_at}
              reason={missing}
            />
          </DataState>
          <DataState state="stale" reason={missing} at={example.stale_at}>
            <Value value={example.known} kind="lower" unit="GPU" stale reason={missing} />
          </DataState>
        </Panel>
      )}
    </>
  );
}
