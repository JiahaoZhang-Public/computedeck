import type { Instance } from './types';

type Endpoint = Pick<Instance, 'host' | 'port' | 'username' | 'ssh_alias'> &
  Partial<Pick<Instance, 'existing_alias'>>;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function directSSHCommand(endpoint: Endpoint): string | null {
  // The alias is defined in the user's own SSH config, on this computer.
  if (endpoint.existing_alias && endpoint.ssh_alias) return `ssh ${shellQuote(endpoint.ssh_alias)}`;
  if (
    !endpoint.host ||
    !endpoint.username ||
    !Number.isInteger(endpoint.port) ||
    !endpoint.port ||
    endpoint.port < 1 ||
    endpoint.port > 65535
  )
    return null;
  return `ssh -p ${endpoint.port} -l ${shellQuote(endpoint.username)} -- ${shellQuote(endpoint.host)}`;
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
