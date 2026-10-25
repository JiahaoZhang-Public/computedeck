import { useState } from 'react';
import { t } from '../i18n';
import { Panel } from '../ui';
import type { Ctx } from '../pages/shared';
import { useRouteParam } from '../useRouteParam';
import { closeLayer, openLayer, replaceLayer } from './routes';
import { ContextPanel, FocusView } from './Surface';
import { useConfirm } from './useConfirm';
import { MenuButton, Popover } from './Popover';

export function LayerGallery({ names, notify }: { names: string[]; notify: Ctx['notify'] }) {
  const [section] = useRouteParam('section');
  const [step] = useRouteParam('step', '1');
  const [subject] = useRouteParam('job', names[0]);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [confirm, confirmation] = useConfirm();
  const close = () => closeLayer(['section', 'step', 'job']);
  const toast = () => {
    notify(t('layer.message'), 'ok', {
      label: t('layer.undo'),
      undo: true,
      run: () => notify(t('layer.reopened')),
    });
    notify(t('layer.message'));
    notify(t('layer.failure'), 'error');
  };
  const actions = (
    <div className="gallery-row">
      <button className="button" onClick={() => openLayer({ section: 'form', step: '1' })}>
        {t('layer.focus')}
      </button>
      <button
        className="button"
        onClick={async () => {
          if (await confirm(t('layer.confirmQuestion'), t('layer.confirm')))
            notify(t('layer.message'));
        }}
      >
        {t('layer.confirm')}
      </button>
      <MenuButton
        label={t('layer.menu')}
        items={[
          { label: t('layer.toast'), action: toast },
          {
            label: t('layer.confirm'),
            action: () => {
              void confirm(t('layer.confirmQuestion'), t('layer.confirm'));
            },
          },
          { label: t('layer.keep'), action: () => {}, disabled: true },
        ]}
      />
      <button className="button" onClick={toast}>
        {t('layer.toast')}
      </button>
      <button className="button" onClick={(event) => setAnchor(event.currentTarget)}>
        {t('layer.popover')}
      </button>
    </div>
  );
  return (
    <Panel title={t('layer.gallery')}>
      <div className="gallery-row">
        <button className="button" onClick={() => openLayer({ section: 'panel' })}>
          {t('layer.panel')}
        </button>
      </div>
      {actions}
      {section === 'panel' && (
        <ContextPanel
          labelledBy="gallery-layer-title"
          close={close}
          onStep={(direction) => {
            const index = names.indexOf(subject);
            if (names[index + direction]) replaceLayer({ job: names[index + direction] });
          }}
        >
          <header className="drawer-header">
            <h2 id="gallery-layer-title">{subject}</h2>
            <button className="button" onClick={close}>
              {t('common.close')}
            </button>
          </header>
          <p className="panel-note">{t('gallery.note')}</p>
          {actions}
        </ContextPanel>
      )}
      {section === 'form' && (
        <FocusView labelledBy="gallery-form-title" close={close} initial="[data-safe]">
          <header className="modal-header">
            <h2 id="gallery-form-title">{t('layer.focus')}</h2>
            <p>{t('layer.step', { step })}</p>
          </header>
          <div className="gallery-row">
            <label>
              {t('layer.name')}
              <input defaultValue={names[0]} />
            </label>
          </div>
          {actions}
          <footer className="modal-footer">
            <button className="button" data-safe onClick={close}>
              {t('common.cancel')}
            </button>
            <button
              className="button"
              onClick={() => replaceLayer({ step: String(Number(step) + 1) })}
            >
              {t('layer.next')}
            </button>
          </footer>
        </FocusView>
      )}
      {confirmation}
      {anchor && (
        <Popover anchor={anchor} close={() => setAnchor(null)} labelledBy="gallery-pop-title">
          <h2 id="gallery-pop-title">{t('layer.popover')}</h2>
          <p>{t('gallery.note')}</p>
          <button className="button" onClick={() => setAnchor(null)}>
            {t('common.close')}
          </button>
        </Popover>
      )}
    </Panel>
  );
}
