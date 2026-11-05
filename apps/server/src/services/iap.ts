// Google Identity-Aware Proxy (SPEC 9.1). When Phi is deployed, IAP signs in the user and adds
// a signed JWT to every request it forwards. Checking it here means a request that reached the
// server some other way (a firewall mistake) is still refused.
// https://cloud.google.com/iap/docs/signed-headers-howto

export const IAP_HEADER = 'x-goog-iap-jwt-assertion';
export const IAP_KEYS_URL = 'https://www.gstatic.com/iap/verify/public_key-jwk';
const ISSUER = 'https://cloud.google.com/iap';
const KEYS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_S = 30;

/** One of Google's IAP signing keys (P-256, ES256). */
export interface Jwk {
  kid: string;
  kty: string;
  crv: string;
  x: string;
  y: string;
  alg?: string;
  use?: string;
}

/** Why a request was refused: 401 without a valid token, 403 for another account. */
export class IapError extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
  }
}

const decoder = new TextDecoder();

function base64url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function json(part: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(decoder.decode(base64url(part)));
    if (value && typeof value === 'object') return value as Record<string, unknown>;
  } catch {
    // reported below
  }
  throw new IapError(401, 'Malformed IAP token');
}

async function fetchGoogleKeys(): Promise<Jwk[]> {
  const res = await fetch(IAP_KEYS_URL);
  if (!res.ok) throw new Error(`Could not fetch IAP keys (${res.status})`);
  return ((await res.json()) as { keys: Jwk[] }).keys;
}

export interface IapVerifierOptions {
  /** /projects/<number>/global/backendServices/<id>, from the load balancer's backend. */
  audience: string;
  /** Only this account gets in (lowercase); null lets anyone IAP admits. */
  allowedEmail: string | null;
  fetchKeys?: () => Promise<Jwk[]>;
  now?: () => number;
}

/** Returns a function that resolves with the signed-in email, or throws an IapError. */
export function createIapVerifier({
  audience,
  allowedEmail,
  fetchKeys = fetchGoogleKeys,
  now = Date.now,
}: IapVerifierOptions) {
  let keys = new Map<string, CryptoKey>();
  let fetchedAt = 0;

  async function keyFor(kid: string): Promise<CryptoKey | undefined> {
    const stale = now() - fetchedAt > KEYS_TTL_MS;
    if (stale || !keys.has(kid)) {
      const next = new Map<string, CryptoKey>();
      for (const jwk of await fetchKeys()) {
        const { kid: id, alg: _alg, use: _use, ...key } = jwk;
        next.set(
          id,
          await crypto.subtle.importKey('jwk', key, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
            'verify',
          ]),
        );
      }
      keys = next;
      fetchedAt = now();
    }
    return keys.get(kid);
  }

  return async function verify(token: string | null): Promise<string> {
    if (!token) throw new IapError(401, 'Sign in through IAP');
    const parts = token.split('.');
    if (parts.length !== 3) throw new IapError(401, 'Malformed IAP token');
    const [head, body, signature] = parts as [string, string, string];
    const header = json(head);
    if (header.alg !== 'ES256' || typeof header.kid !== 'string') {
      throw new IapError(401, 'Unexpected IAP token algorithm');
    }
    const key = await keyFor(header.kid);
    if (!key) throw new IapError(401, 'Unknown IAP signing key');
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      base64url(signature),
      new TextEncoder().encode(`${head}.${body}`),
    );
    if (!valid) throw new IapError(401, 'Invalid IAP signature');

    const claims = json(body);
    const seconds = now() / 1000;
    if (claims.iss !== ISSUER) throw new IapError(401, 'Wrong IAP issuer');
    if (claims.aud !== audience) throw new IapError(401, 'IAP token is for another backend');
    if (typeof claims.exp !== 'number' || claims.exp < seconds - CLOCK_SKEW_S) {
      throw new IapError(401, 'IAP token expired');
    }
    if (typeof claims.iat === 'number' && claims.iat > seconds + CLOCK_SKEW_S) {
      throw new IapError(401, 'IAP token issued in the future');
    }
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
    if (allowedEmail && email !== allowedEmail) {
      throw new IapError(403, 'This account may not use this Phi');
    }
    return email;
  };
}

export type IapVerifier = ReturnType<typeof createIapVerifier>;
