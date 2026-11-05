import { describe, expect, spyOn, test } from 'bun:test';

import { ConflictError } from '../../services/fs.ts';
import { IapError } from '../../services/iap.ts';
import { PathError } from '../../services/paths.ts';
import { guard, HttpError, type Access } from '../security.ts';

const ok = guard(() => Response.json({ ok: true }), 3000);
const throwing = (err: unknown) =>
  guard(() => {
    throw err;
  }, 3000);

const req = (headers: Record<string, string> = {}, url = 'http://127.0.0.1:3000/api/x') =>
  new Request(url, { headers });

describe('origin and host checks', () => {
  test('allows local origins and requests without Origin', async () => {
    expect((await ok(req())).status).toBe(200);
    expect((await ok(req({ origin: 'http://127.0.0.1:3000' }))).status).toBe(200);
    expect(
      (await ok(req({ origin: 'http://localhost:3000' }, 'http://localhost:3000/api/x'))).status,
    ).toBe(200);
  });

  test('rejects foreign origins, other ports and https with 403', async () => {
    for (const origin of [
      'https://evil.example',
      'http://127.0.0.1:4000',
      'https://127.0.0.1:3000',
      'http://127.0.0.1:3000.evil.example',
      'null',
    ]) {
      const res = await ok(req({ origin }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Forbidden origin' });
    }
  });

  test('rejects a foreign Host even without Origin (DNS rebinding)', async () => {
    expect((await ok(req({}, 'http://evil.example:3000/api/x'))).status).toBe(403);
  });
});

describe('deployed (SPEC 9.1)', () => {
  const PUBLIC = 'https://phi.example.com';
  /** Stands in for the IAP verifier: "good" is a valid token, "other" another account. */
  const iap = async (token: string | null) => {
    if (token === 'good') return 'me@example.com';
    if (token === 'other') throw new IapError(403, 'This account may not use this Phi');
    throw new IapError(401, 'Sign in through IAP');
  };
  const access: Access = { port: 3000, publicOrigin: PUBLIC, iap };
  const deployed = guard(() => Response.json({ ok: true }), access);
  const at = (headers: Record<string, string>, url = `${PUBLIC}/api/x`) =>
    new Request(url, { headers });

  test('the public origin and host pass with a valid IAP token', async () => {
    const res = await deployed(at({ origin: PUBLIC, 'x-goog-iap-jwt-assertion': 'good' }));
    expect(res.status).toBe(200);
    // Same-origin GETs carry no Origin header.
    expect((await deployed(at({ 'x-goog-iap-jwt-assertion': 'good' }))).status).toBe(200);
  });

  test('without the token 401, another account 403, both before the handler runs', async () => {
    let ran = false;
    const handler = guard(() => {
      ran = true;
      return new Response();
    }, access);
    const missing = await handler(at({ origin: PUBLIC }));
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'Sign in through IAP' });
    expect((await handler(at({ 'x-goog-iap-jwt-assertion': 'other' }))).status).toBe(403);
    expect(ran).toBe(false);
  });

  test('a valid token still needs the right origin and host', async () => {
    const token = { 'x-goog-iap-jwt-assertion': 'good' };
    expect((await deployed(at({ ...token, origin: 'https://evil.example' }))).status).toBe(403);
    expect((await deployed(at(token, 'https://evil.example/api/x'))).status).toBe(403);
  });

  test('without PUBLIC_ORIGIN or IAP, local behavior is unchanged', async () => {
    expect((await ok(at({ origin: PUBLIC }, 'http://127.0.0.1:3000/api/x'))).status).toBe(403);
    expect((await ok(at({}, 'http://127.0.0.1:3000/api/x'))).status).toBe(200);
  });
});

describe('error mapping', () => {
  test('path errors and URI errors → 400', async () => {
    const res = await throwing(new PathError('Path must not contain ".."'))(req());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Path must not contain ".."' });
    expect((await throwing(new URIError('URI malformed'))(req())).status).toBe(400);
  });

  test('ConflictError → 409 with path and current mtime', async () => {
    const res = await throwing(new ConflictError('main.tex', 123.5))(req());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'conflict', path: 'main.tex', mtimeMs: 123.5 });
  });

  test('HttpError keeps its status', async () => {
    expect((await throwing(new HttpError(400, 'bad'))(req())).status).toBe(400);
  });

  test('missing files → 404', async () => {
    const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    expect((await throwing(enoent)(req())).status).toBe(404);
  });

  test('anything else → 500 with the message, stack logged', async () => {
    const log = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await throwing(new Error('kaboom'))(req());
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'kaboom' });
      expect(String(log.mock.calls[0]?.[0])).toContain('Error: kaboom');
    } finally {
      log.mockRestore();
    }
  });
});
