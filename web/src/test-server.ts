/** Test fixtures use the real server contract, not a second copy of its arithmetic. */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { ComputeNode, Dashboard, NodeSummary } from './types';

const root = path.resolve(process.cwd(), '..');
function server(input: unknown) {
  return JSON.parse(
    execFileSync(
      path.join(root, '.venv', 'bin', 'python'),
      [
        '-c',
        `
import json, sys
from computedeck.summary import summarize, summarize_nodes
from computedeck import attention, drivers
from datetime import datetime, UTC
from computedeck.drivers.base import node_health
request = json.load(sys.stdin)
if 'demo' in request:
    from computedeck.demo import dashboard
    result = dashboard()
elif 'state' in request:
    result = node_health(request['state'])
elif 'nodes' in request:
    result = summarize_nodes(request['nodes'])
else:
    data = request['data']
    for node in data['nodes']:
        node['health'] = node_health(node['state'])
    data['summary'] = summarize(data)
    data.setdefault('attention', attention.derive(data, [drivers.describe(name) for name in drivers.names()], now=datetime.now(UTC)))
    result = data
json.dump(result, sys.stdout)
`,
      ],
      { cwd: root, input: JSON.stringify(input), encoding: 'utf8' },
    ),
  );
}

export function serverDashboard(data: Omit<Dashboard, 'summary'>): Dashboard {
  return server({ data });
}
export function serverNodeHealth(state: string): ComputeNode['health'] {
  return server({ state });
}
export function serverNodes(nodes: ComputeNode[]): NodeSummary {
  return server({ nodes });
}

export function serverDemo(): Dashboard {
  return server({ demo: true });
}
