import type { Dashboard, Instance, Kind, Source } from './types';

/** A cluster (all logins with one cluster_id) or a cloud platform, derived from the data. */
export interface Group {
  key: string;
  label: string;
  kind: Kind;
  sources: Source[];
  /** Palette slot, assigned by order so that no name needs its own color. */
  color: number;
  initials: string;
}

export function initials(label: string) {
  const words = label.split(/[\s_.-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] ?? '?').slice(0, 2).toUpperCase();
}

export function instanceGroupKey(item: Instance, sources: Source[]) {
  const source =
    item.source_id === 'manual' ? undefined : sources.find((each) => each.id === item.source_id);
  return source ? source.cluster_id : `platform:${item.platform.trim().toLowerCase()}`;
}

export function groupsOf(data: Pick<Dashboard, 'sources' | 'instances'>): Group[] {
  const result = new Map<string, Omit<Group, 'color' | 'initials'>>();
  for (const source of data.sources) {
    const group = result.get(source.cluster_id);
    if (group) group.sources.push(source);
    else
      result.set(source.cluster_id, {
        key: source.cluster_id,
        label: source.name,
        kind: source.kind,
        sources: [source],
      });
  }
  for (const item of data.instances) {
    const key = instanceGroupKey(item, data.sources);
    if (!result.has(key))
      result.set(key, { key, label: item.platform, kind: 'cloud', sources: [] });
  }
  return [...result.values()].map((group, index) => ({
    ...group,
    color: index % 8,
    initials: initials(group.label),
  }));
}

export function findGroup(groups: Group[], key: string) {
  return groups.find((group) => group.key === key);
}

export function groupLabel(groups: Group[], key: string) {
  return findGroup(groups, key)?.label ?? key;
}

/** A login named with its cluster or platform: "Cluster A · alice". */
export function sourceLabel(groups: Group[], source: Source) {
  const group = groupLabel(groups, source.cluster_id);
  const login = source.username || source.name;
  return login && login !== group ? `${group} · ${login}` : group;
}

/** Several logins, named as `sourceLabel` names them. */
export function sourceList(groups: Group[], sources: Source[]) {
  return sources.map((source) => sourceLabel(groups, source)).join(', ');
}
