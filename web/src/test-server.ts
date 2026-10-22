/** Test fixtures use the real server contract, not a second copy of its arithmetic. */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { ComputeNode, Dashboard, NodeSummary, Source } from './types';

const root = path.resolve(process.cwd(), '..');
function server(input: unknown) {
  return JSON.parse(
    execFileSync(
      path.join(root, '.venv', 'bin', 'python'),
      [
        '-c',
        `
import json, sys
from computedeck.summary import PENDING, RUNNING, summarize, summarize_nodes
from computedeck import attention, drivers
from datetime import datetime, UTC
from computedeck.drivers.base import cluster_state, node_health
request = json.load(sys.stdin)
if 'demo' in request:
    from computedeck.demo import dashboard
    result = dashboard()
elif 'cluster_nodes' in request:
    result = cluster_state(request['cluster_nodes'], require_partition=True)
elif 'state' in request:
    result = node_health(request['state'], partitions=request.get('partitions'))
elif 'running_states' in request:
    result = sorted(RUNNING)
elif 'pending_states' in request:
    result = sorted(PENDING)
elif 'nodes' in request:
    result = summarize_nodes(request['nodes'])
else:
    data = request['data']
    for node in data['nodes']:
        source = next((s for s in data['sources'] if s['id'] == node['source_id']), {})
        node['health'] = node_health(node['state'], partitions=node.get('partitions', []) if source.get('driver') == 'slurm' else None)
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
export function serverNodeHealth(state: string, partitions?: string[]): ComputeNode['health'] {
  return server({ state, partitions });
}
export function serverNodes(nodes: ComputeNode[]): NodeSummary {
  return server({ nodes });
}

export function serverDemo(): Dashboard {
  return server({ demo: true });
}

export function serverPendingStates(): string[] {
  return server({ pending_states: true });
}

export function serverRunningStates(): string[] {
  return server({ running_states: true });
}

export function serverClusterState(nodes: ComputeNode[]): Source['cluster_state'] {
  return server({ cluster_nodes: nodes });
}
