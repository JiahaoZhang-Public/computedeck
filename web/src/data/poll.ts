// Array endpoints keep their public JSON shape. Keep their HTTP token out of the data.
export const responseTokens = new WeakMap<object, string>();
export type Unchanged = { unchanged: true; token: string };

export function sincePath(path: string, token?: string) {
  return token
    ? `${path}${path.includes('?') ? '&' : '?'}since=${encodeURIComponent(token)}`
    : path;
}

export function tokenOf(value: object): string | undefined {
  return responseTokens.get(value) ?? ('token' in value ? (value.token as string) : undefined);
}

export function changed<T extends object>(value: T | Unchanged | null): value is T {
  return value !== null && !('unchanged' in value);
}
