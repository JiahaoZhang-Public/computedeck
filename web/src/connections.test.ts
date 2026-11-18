import { describe, expect, it } from 'vitest';
import { clientSSHConfig, directSSHCommand, routeJump } from './connections';

const endpoint = { host: 'gpu.example.com', port: 22022, username: 'root', ssh_alias: 'cd-gpu' };

describe('remote workspace client connections', () => {
  it('preserves existing SSH aliases and their jump-host configuration', () => {
    const existing = {
      existing_alias: true,
      host: 'gpu-box',
      port: 22,
      username: 'alice',
      ssh_alias: 'gpu-box',
    };
    expect(directSSHCommand(existing)).toBe("ssh 'gpu-box'");
    const config = clientSSHConfig([existing]);
    expect(config).toContain('# Uses existing SSH configuration: gpu-box');
    expect(config).not.toContain('HostName');
  });
  it('exports endpoints without importing any server paths or key references', () => {
    const config = clientSSHConfig([
      { ...endpoint, identity_file: '/server/private/key' } as typeof endpoint,
    ]);
    expect(config).toContain(
      'Host cd-gpu\n    HostName gpu.example.com\n    Port 22022\n    User root',
    );
    expect(config).not.toContain('IdentityFile');
    expect(config).not.toContain('/server/');
    expect(config).not.toContain('Include');
  });
  it('copies a direct command using the client default keys instead of server configuration', () => {
    expect(directSSHCommand(endpoint)).toBe("ssh -p 22022 -l 'root' -- 'gpu.example.com'");
    expect(directSSHCommand(endpoint)).not.toContain(' -F ');
    expect(directSSHCommand(endpoint)).not.toContain(' -i ');
  });
  it('quotes shell-sensitive endpoint text as a single argument', () => {
    expect(directSSHCommand({ ...endpoint, host: "host'; touch /tmp/example; '" })).toBe(
      "ssh -p 22022 -l 'root' -- 'host'\\''; touch /tmp/example; '\\'''",
    );
  });
  it('adds the jump host of a jump route, and only of a jump route', () => {
    const nodes = [
      { id: 'example:campus-bastion', mode: 'jump' as const, ssh_alias: 'campus-bastion' },
      { id: 'example:lab-gateway', mode: 'collect' as const, ssh_alias: 'lab-gateway' },
    ];
    const jump = routeJump({ node: 'example:campus-bastion' }, nodes);
    expect(jump).toBe('campus-bastion');
    expect(routeJump({ node: 'example:lab-gateway' }, nodes)).toBeNull();
    expect(routeJump({ node: '' }, nodes)).toBeNull();
    expect(routeJump(undefined, nodes)).toBeNull();
    expect(
      directSSHCommand({ ...endpoint, existing_alias: true, ssh_alias: 'lab-server' }, jump),
    ).toBe("ssh -J 'campus-bastion' 'lab-server'");
    expect(directSSHCommand(endpoint, jump)).toBe(
      "ssh -J 'campus-bastion' -p 22022 -l 'root' -- 'gpu.example.com'",
    );
  });
  it('omits incomplete endpoints and blocks SSH config directive injection', () => {
    expect(directSSHCommand({ ...endpoint, host: null })).toBeNull();
    expect(clientSSHConfig([{ ...endpoint, port: null }])).toBe('');
    expect(clientSSHConfig([{ ...endpoint, host: 'host\nProxyCommand arbitrary' }])).toBe('');
    expect(clientSSHConfig([{ ...endpoint, ssh_alias: '*\nInclude /server/path' }])).toBe('');
  });
});
