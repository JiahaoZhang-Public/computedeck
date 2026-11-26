import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { BrandMark, Chips, Empty, Meter, Panel, Stat, Status, Switch } from '../ui';

// Literal WEB_API 1 DOM from eace2d4:web/src/ui.tsx. Do not regenerate from current components.
it('preserves all eight exported component trees from 0.7', () => {
  const cases = [
    [
      <Status state="RUNNING" label="Running" />,
      '<span class="status green"><i></i>Running</span>',
    ],
    [
      <Panel title="Jobs" count={3} actions={<button>Refresh</button>}>
        <p>Rows</p>
      </Panel>,
      '<section class="panel "><header class="panel-header"><h2>Jobs<span class="count">3</span></h2><div class="panel-actions"><button>Refresh</button></div></header><p>Rows</p></section>',
    ],
    [
      <Chips
        label="State"
        value="all"
        onChange={() => {}}
        options={[
          { value: 'all', label: 'All', count: 3 },
          { value: 'running', label: 'Running' },
        ]}
      />,
      '<div class="chips" role="tablist" aria-label="State"><button role="tab" aria-selected="true" class="active">All<span>3</span></button><button role="tab" aria-selected="false" class="">Running</button></div>',
    ],
    [
      <Switch checked label="On" onChange={() => {}} />,
      '<label class="switch "><span>On</span><input type="checkbox" role="switch" checked=""/><i aria-hidden="true"></i></label>',
    ],
    [
      <Switch checked={false} disabled label="Off" name="Collection" onChange={() => {}} />,
      '<label class="switch disabled"><span aria-hidden="true">Off</span><input type="checkbox" role="switch" aria-label="Collection" disabled=""/><i aria-hidden="true"></i></label>',
    ],
    [
      <Stat label="Held" value={4} unit="GPU" hint="Mine" />,
      '<div class="stat"><span class="stat-label">Held</span><span class="stat-value">4<small>GPU</small></span><span class="stat-hint">Mine</span></div>',
    ],
    [
      <Meter value={37.5} />,
      '<span class="meter "><span class="meter-track"><i style="width:37.5%"></i></span><span class="meter-text">38%</span></span>',
    ],
    [
      <Meter value={null} />,
      '<span class="meter unknown"><span class="meter-track"><i style="width:0%"></i></span><span class="meter-text">—</span></span>',
    ],
    [
      <Empty title="No jobs" text="Nothing running" action={<button>Connect</button>} />,
      '<div class="empty"><strong>No jobs</strong><p>Nothing running</p><button>Connect</button></div>',
    ],
  ] as const;
  for (const [node, literal] of cases) expect(renderToStaticMarkup(node)).toBe(literal);
});

it('preserves the non-default BrandMark SVG from 0.7', () => {
  expect(renderToStaticMarkup(<BrandMark size={31} />)).toBe(
    '<svg class="brand-svg" width="31" height="31" viewBox="-3.44 0 106.89 106.89" aria-hidden="true"><path class="brand-base" d="M0.00 65.91Q0.00 64.41 1.32 65.11L42.16 86.75Q50.10 90.96 58.00 86.69L96.05 66.15Q100.00 64.01 100.00 68.50L100.00 80.72Q100.00 82.51 98.41 83.36L57.80 104.88Q50.13 108.94 42.46 104.88L4.50 84.76Q0.00 82.37 0.00 77.28Z"></path><path class="brand-middle" d="M0.00 40.69Q0.00 39.20 1.33 39.89L42.03 61.05Q49.99 65.19 57.96 61.05L83.21 47.92Q87.72 45.57 87.72 50.66L87.72 59.41Q87.72 63.90 83.77 66.04L57.74 80.10Q50.10 84.22 42.42 80.16L4.50 60.06Q0.00 57.67 0.00 52.58Z"></path><path class="brand-top" d="M42.12 2.15Q50.03 -2.12 57.96 2.09L93.35 20.85Q107.11 28.14 93.41 35.54L58.14 54.58Q50.24 58.85 42.30 54.64L6.91 35.89Q-6.85 28.60 6.85 21.20Z"></path></svg>',
  );
});
