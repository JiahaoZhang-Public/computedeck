import { useEffect, useState } from 'react';
import { api } from './api';

/** A concrete `Host` entry of the service user's SSH configuration; never key material. */
export interface SshHost {
  alias: string;
  hostname: string | null;
  user: string | null;
  proxy_jump: string | null;
}

const cache = new Map<boolean, Promise<SshHost[]>>();

/** Host aliases to suggest; empty when the file is unreadable or the service is older. */
export function loadSshHosts(demo: boolean): Promise<SshHost[]> {
  let hosts = cache.get(demo);
  if (!hosts) {
    hosts = api<{ hosts?: SshHost[] } | null>(`/ssh/hosts?demo=${demo}`).then(
      (result) => (Array.isArray(result?.hosts) ? result.hosts : []),
      () => {
        // A failed read is retried the next time a form opens.
        cache.delete(demo);
        return [];
      },
    );
    cache.set(demo, hosts);
  }
  return hosts;
}

export function useSshHosts(demo: boolean): SshHost[] {
  const [hosts, setHosts] = useState<SshHost[]>([]);
  useEffect(() => {
    let current = true;
    void loadSshHosts(demo).then((next) => {
      if (current) setHosts(next);
    });
    return () => {
      current = false;
    };
  }, [demo]);
  return hosts;
}

/** What a suggestion shows beside the alias: `user@hostname`, or whichever part is known. */
export function sshHostHint(host: SshHost): string {
  return [host.user, host.hostname].filter(Boolean).join('@');
}
