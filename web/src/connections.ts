import type { CollectionNode, Instance, Source } from './types';

type Endpoint = Pick<Instance, 'host' | 'port' | 'username' | 'ssh_alias'> &
  Partial<Pick<Instance, 'existing_alias'>>;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** The jump host's SSH alias when a source is reached through a jump route. */
export function routeJump(
  source: Pick<Source, 'node'> | undefined,
  nodes: Pick<CollectionNode, 'id' | 'mode' | 'ssh_alias'>[] | undefined,
): string | null {
  const node = source?.node ? nodes?.find((item) => item.id === source.node) : undefined;
  return node?.mode === 'jump' && node.ssh_alias ? node.ssh_alias : null;
}

/** A command for this computer; `jump` adds the route's hop, as ssh -J does. */
export function directSSHCommand(endpoint: Endpoint, jump?: string | null): string | null {
  const ssh = jump ? `ssh -J ${shellQuote(jump)}` : 'ssh';
  // The alias is defined in the user's own SSH config, on this computer.
  if (endpoint.existing_alias && endpoint.ssh_alias)
    return `${ssh} ${shellQuote(endpoint.ssh_alias)}`;
  if (
    !endpoint.host ||
    !endpoint.username ||
    !Number.isInteger(endpoint.port) ||
    !endpoint.port ||
    endpoint.port < 1 ||
    endpoint.port > 65535
  )
    return null;
  return `${ssh} -p ${endpoint.port} -l ${shellQuote(endpoint.username)} -- ${shellQuote(endpoint.host)}`;
}

export function clientSSHConfig(endpoints: Endpoint[]): string {
  return endpoints
    .filter(
      (endpoint) =>
        endpoint.host &&
        /^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(endpoint.host) &&
        /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(endpoint.username) &&
        /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(endpoint.ssh_alias) &&
        Number.isInteger(endpoint.port) &&
        endpoint.port! > 0 &&
        endpoint.port! <= 65535,
    )
    .map((endpoint) =>
      endpoint.existing_alias
        ? `# Uses existing SSH configuration: ${endpoint.ssh_alias}\n`
        : [
            `Host ${endpoint.ssh_alias}`,
            `    HostName ${endpoint.host}`,
            `    Port ${endpoint.port}`,
            `    User ${endpoint.username}`,
            '    StrictHostKeyChecking yes',
            '',
          ].join('\n'),
    )
    .join('\n');
}
