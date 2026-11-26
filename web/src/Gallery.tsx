import { LayerGallery } from './layers/LayerGallery';
import type { Ctx } from './pages/shared';
import { useState } from 'react';
import { t } from './i18n';
import { BrandMark, Chips, Empty, Meter, Panel, Stat, Status, Switch } from './ui';
import './gallery.css';
import { DisplayGallery } from './ui/DisplayGallery';
import type { Dashboard } from './types';

// The WEB_API 1 names are deliberately literal: this page catches accidental removals.
const tokens = [
  '--text',
  '--text-2',
  '--text-3',
  '--text-4',
  '--surface',
  '--surface-2',
  '--border',
  '--accent',
  '--accent-soft',
  '--accent-text',
  '--gray-soft',
  '--green',
  '--green-soft',
  '--amber',
  '--amber-soft',
  '--red',
  '--radius',
  '--radius-sm',
  '--mono',
  '--accent-hover',
  '--text-muted',
];

export function Gallery({
  compat,
  data,
  notify,
}: {
  compat: boolean;
  data?: Dashboard;
  notify?: Ctx['notify'];
}) {
  const [enabled, setEnabled] = useState(false);
  const [tab, setTab] = useState('running');
  return (
    <div className="gallery">
      <p className="page-note">{t('gallery.note')}</p>
      <a className="link" href={compat ? '#/__gallery' : '#/__gallery?compat'}>
        {t(compat ? 'gallery.components' : 'gallery.compat')}
      </a>
      {compat ? (
        <>
          <Panel title={t('gallery.classes')}>
            <p className="panel-note">{t('gallery.example')}</p>
            <div className="gallery-row">
              {['button', 'button primary', 'button primary-button', 'button secondary-button'].map(
                (name) => (
                  <button key={name} className={name} onClick={() => setEnabled(!enabled)}>
                    {name}
                  </button>
                ),
              )}
            </div>
            <div className="gallery-row">
              {['green', 'amber', 'red'].map((tone) => (
                <span key={tone} className={`status ${tone}`}>
                  {tone}
                </span>
              ))}
              <BrandMark />
              <span className="spin" aria-hidden="true">
                <BrandMark size={16} />
              </span>
            </div>
            <div className="gallery-stack">
              <p className="form-error">{t('gallery.error')}</p>
              <p className="red-text">{t('gallery.error')}</p>
              <p className="red">{t('gallery.error')}</p>
              <p className="amber">{t('gallery.warning')}</p>
              <p className="muted">{t('gallery.example')}</p>
              <p className="sub">{t('gallery.example')}</p>
            </div>
            <div className="banner amber">{t('gallery.warning')}</div>
            <div className="gallery-row">
              <label>
                {t('gallery.input')}
                <input defaultValue={t('gallery.example')} />
              </label>
              <label>
                {t('gallery.select')}
                <select defaultValue="a">
                  <option value="a">{t('gallery.example')}</option>
                </select>
              </label>
              <a href="#/overview">{t('nav.overview')}</a>
              <a className="link" href="#/jobs">
                {t('nav.jobs')}
              </a>
              <Switch checked={enabled} label={t('gallery.switch')} onChange={setEnabled} />
            </div>
            <div className="table-wrap">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>{t('gallery.example')}</th>
                    <th>{t('gallery.value')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      {t('gallery.example')}
                      <span className="sub">{t('gallery.note')}</span>
                    </td>
                    <td className="num">42</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Panel>
          <Panel title={t('gallery.tokens')}>
            <ul className="gallery-tokens">
              {tokens.map((token) => (
                <li key={token} data-token={token}>
                  <code>{token}</code>
                  {token === '--mono' ? (
                    <span style={{ fontFamily: `var(${token})` }}>{t('gallery.example')}</span>
                  ) : (
                    <span
                      className="gallery-swatch"
                      aria-hidden="true"
                      style={
                        token.startsWith('--radius')
                          ? { borderRadius: `var(${token})` }
                          : { backgroundColor: `var(${token})` }
                      }
                    />
                  )}
                </li>
              ))}
            </ul>
          </Panel>
        </>
      ) : (
        <>
          <Panel title={t('gallery.components')} count={8}>
            <div className="gallery-row">
              <BrandMark />
              {['RUNNING', 'PENDING', 'stale', 'FAILED', 'unknown', 'stopped'].map((state) => (
                <Status key={state} state={state} />
              ))}
            </div>
            <div className="gallery-row">
              <Meter value={65} />
              <Meter value={null} />
              <Stat label={t('gallery.value')} value={42} unit="GPU" hint={t('gallery.note')} />
            </div>
            <div className="gallery-row">
              <Chips
                value={tab}
                label={t('gallery.select')}
                onChange={setTab}
                options={[
                  { value: 'running', label: t('status.running') },
                  { value: 'unknown', label: t('status.unknown') },
                ]}
              />
              <Switch checked={enabled} label={t('gallery.switch')} onChange={setEnabled} />
            </div>
          </Panel>
          <Empty title={t('gallery.empty')} text={t('gallery.note')} />
          <DisplayGallery example={data?.display_example} />
          {data?.layer_example && notify && (
            <LayerGallery names={data.layer_example.names} notify={notify} />
          )}
        </>
      )}
    </div>
  );
}
