/**
 * A browser session token, valid only for the current service process. The persistent
 * API token is never stored here. Cookies and URLs never carry credentials.
 *
 * Before a stored token is sent, the service must prove it issued it: it answers a random
 * challenge with an HMAC keyed by the token. Another program that took the port (an SSH
 * tunnel that stopped, a service that is restarting) cannot, so it never receives it.
 */
const KEY = 'computedeck.session';
// Retire the persistent credential saved by older versions.
try {
  window.localStorage.removeItem('computedeck.token');
} catch {
  /* Storage may be unavailable. */
}
let memory: string | null = null;
let rejected = false;
let pending: Promise<string | null> | null = null;

export function currentToken(): string | null {
  if (memory) return memory;
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setToken(value: string) {
  memory = value.trim();
  rejected = false;
  try {
    window.localStorage.setItem(KEY, memory);
  } catch {
    /* Without storage the token lasts until the page is reloaded. */
  }
}

function forgetToken() {
  memory = null;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* Nothing stored. */
  }
}

/** True once a stored session was dropped because the service could not prove it. */
export function sessionRejected(): boolean {
  return rejected;
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** HMAC-SHA256 of the challenge, as the service computes it for its session token. */
export async function sessionProof(token: string, challenge: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(
    await crypto.subtle.sign('HMAC', key, encoder.encode(`computedeck-browser:${challenge}`)),
  );
}

async function verify(token: string): Promise<string | null> {
  const challenge = hex(crypto.getRandomValues(new Uint8Array(32)));
  // A network failure throws: nothing is sent, and the token is kept for when it is back.
  const response = await fetch(`/api/ping?session_challenge=${challenge}`, { credentials: 'omit' });
  let proof: unknown = null;
  try {
    proof = response.ok ? (await response.json()).session_proof : null;
  } catch {
    /* Not JSON: not this service. */
  }
  if (typeof proof === 'string' && proof === (await sessionProof(token, challenge))) return token;
  if (currentToken() === token) {
    forgetToken();
    rejected = true;
  }
  return null;
}

/** The stored session token, once the service has proved it issued it; else null. */
export function verifiedToken(): Promise<string | null> {
  const token = currentToken();
  if (!token) return Promise.resolve(null);
  // Requests made together share one check.
  pending ??= verify(token).finally(() => {
    pending = null;
  });
  return pending;
}
