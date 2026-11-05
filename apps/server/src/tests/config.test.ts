import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../config.ts';

/** What an unconfigured machine gets: Phi on 127.0.0.1, no deployment settings. */
const LOCAL = {
  port: 3000,
  host: '127.0.0.1',
  initialProjectRoot: null,
  publicOrigin: null,
  projectsDir: null,
  iap: null,
  production: false,
};

test('defaults: port 3000 on 127.0.0.1, nothing deployed; PROJECT_ROOT is resolved', () => {
  expect(loadConfig({})).toEqual(LOCAL);
  expect(loadConfig({ PROJECT_ROOT: tmpdir() })).toEqual({
    ...LOCAL,
    initialProjectRoot: tmpdir(),
  });
});

test('PROJECT_ROOT and PROJECTS_DIR must exist if set', () => {
  const missing = join(tmpdir(), 'does-not-exist-phi');
  expect(() => loadConfig({ PROJECT_ROOT: missing })).toThrow('does not exist');
  expect(() => loadConfig({ PROJECTS_DIR: missing })).toThrow('PROJECTS_DIR folder does not exist');
});

test('rejects an invalid PORT', () => {
  expect(() => loadConfig({ PORT: 'abc', PROJECT_ROOT: tmpdir() })).toThrow('PORT');
});

test('deployed (SPEC 9.1): the public origin, IAP, the projects folder and production mode', () => {
  expect(
    loadConfig({
      HOST: '0.0.0.0',
      PUBLIC_ORIGIN: 'https://phi.example.com/',
      PROJECTS_DIR: tmpdir(),
      IAP_AUDIENCE: '/projects/1/global/backendServices/2',
      ALLOWED_EMAIL: 'Me@Example.com',
      NODE_ENV: 'production',
    }),
  ).toEqual({
    ...LOCAL,
    host: '0.0.0.0',
    publicOrigin: 'https://phi.example.com',
    projectsDir: tmpdir(),
    iap: { audience: '/projects/1/global/backendServices/2', allowedEmail: 'me@example.com' },
    production: true,
  });
});

test('another interface than loopback needs IAP, or an explicit ALLOW_NO_AUTH', () => {
  expect(() => loadConfig({ HOST: '0.0.0.0' })).toThrow('has no login of its own');
  expect(loadConfig({ HOST: '0.0.0.0', ALLOW_NO_AUTH: '1' }).host).toBe('0.0.0.0');
  expect(loadConfig({ HOST: 'localhost' }).host).toBe('localhost');
});

test('PUBLIC_ORIGIN must be an origin, not a page', () => {
  expect(() => loadConfig({ PUBLIC_ORIGIN: 'https://phi.example.com/app' })).toThrow('origin');
  expect(() => loadConfig({ PUBLIC_ORIGIN: 'not a url' })).toThrow();
});
