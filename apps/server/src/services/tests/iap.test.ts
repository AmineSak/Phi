import { beforeAll, describe, expect, test } from 'bun:test';

import { createIapVerifier, IapError, type Jwk } from '../iap.ts';

const AUDIENCE = '/projects/123/global/backendServices/456';
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

const b64url = (bytes: Uint8Array | string) =>
  Buffer.from(bytes).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** A P-256 key pair standing in for one of Google's IAP keys. */
async function keyPair(kid: string) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Omit<Jwk, 'kid'>;
  return { privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: 'ES256' } as Jwk };
}

type Pair = Awaited<ReturnType<typeof keyPair>>;
let google: Pair;
let attacker: Pair;

beforeAll(async () => {
  google = await keyPair('key-1');
  attacker = await keyPair('key-1');
});

/** A token as IAP signs it; `claims` override the valid defaults. */
async function token(claims: Record<string, unknown> = {}, signer = google, kid = 'key-1') {
  const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }));
  const body = b64url(
    JSON.stringify({
      iss: 'https://cloud.google.com/iap',
      aud: AUDIENCE,
      email: 'me@example.com',
      iat: NOW / 1000 - 10,
      exp: NOW / 1000 + 590,
      ...claims,
    }),
  );
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signer.privateKey,
    new TextEncoder().encode(`${header}.${body}`),
  );
  return `${header}.${body}.${b64url(new Uint8Array(signature))}`;
}

function verifier(allowedEmail: string | null = 'me@example.com', keys = () => [google.jwk]) {
  let fetches = 0;
  const verify = createIapVerifier({
    audience: AUDIENCE,
    allowedEmail,
    fetchKeys: async () => {
      fetches++;
      return keys();
    },
    now: () => NOW,
  });
  return { verify, fetches: () => fetches };
}

/** The status the verifier refuses `promise` with. */
async function refused(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof IapError) return err.status;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('IAP signed header (SPEC 9.1)', () => {
  test('a valid token from the allowed account passes, its email returned', async () => {
    const { verify } = verifier();
    expect(await verify(await token())).toBe('me@example.com');
    expect(await verify(await token({ email: 'ME@example.com' }))).toBe('me@example.com');
  });

  test('missing, malformed, forged or not ES256: 401', async () => {
    const { verify } = verifier();
    expect(await refused(verify(null))).toBe(401);
    expect(await refused(verify('not.a-token'))).toBe(401);
    expect(await refused(verify('a.b.c'))).toBe(401);
    // Signed by another key under the same key id.
    expect(await refused(verify(await token({}, attacker)))).toBe(401);
    // A valid signature over other claims: the body was swapped.
    const [head, , sig] = (await token()).split('.');
    const forgedBody = b64url(JSON.stringify({ aud: AUDIENCE, email: 'x@y.z', exp: 9e9 }));
    expect(await refused(verify(`${head}.${forgedBody}.${sig}`))).toBe(401);
    const none = `${b64url(JSON.stringify({ alg: 'none', kid: 'key-1' }))}.${b64url('{}')}.`;
    expect(await refused(verify(none))).toBe(401);
  });

  test('another backend, another issuer, expired or issued in the future: 401', async () => {
    const { verify } = verifier();
    expect(
      await refused(verify(await token({ aud: '/projects/9/global/backendServices/9' }))),
    ).toBe(401);
    expect(await refused(verify(await token({ iss: 'https://evil.example' })))).toBe(401);
    expect(await refused(verify(await token({ exp: NOW / 1000 - 3600 })))).toBe(401);
    expect(await refused(verify(await token({ iat: NOW / 1000 + 3600 })))).toBe(401);
  });

  test('another Google account: 403; with no ALLOWED_EMAIL anyone IAP admits passes', async () => {
    expect(await refused(verifier().verify(await token({ email: 'other@example.com' })))).toBe(403);
    expect(await verifier(null).verify(await token({ email: 'other@example.com' }))).toBe(
      'other@example.com',
    );
  });

  test("Google's keys are fetched once, and again for a key id it doesn't know yet", async () => {
    let served = [google.jwk];
    const { verify, fetches } = verifier('me@example.com', () => served);
    await verify(await token());
    await verify(await token());
    expect(fetches()).toBe(1);
    // Google rotated its keys: the new kid triggers a refresh.
    const rotated = await keyPair('key-2');
    served = [google.jwk, rotated.jwk];
    expect(await verify(await token({}, rotated, 'key-2'))).toBe('me@example.com');
    expect(fetches()).toBe(2);
    // Still unknown after the refresh: refused.
    expect(await refused(verify(await token({}, rotated, 'key-3')))).toBe(401);
  });
});
