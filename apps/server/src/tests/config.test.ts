import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../config.ts';

test('defaults PORT to 3000 and resolves PROJECT_ROOT', () => {
  expect(loadConfig({ PROJECT_ROOT: tmpdir() })).toEqual({
    port: 3000,
    initialProjectRoot: tmpdir(),
  });
});

test('PROJECT_ROOT is optional (a project can be opened from the app), but must exist if set', () => {
  expect(loadConfig({})).toEqual({ port: 3000, initialProjectRoot: null });
  expect(() => loadConfig({ PROJECT_ROOT: join(tmpdir(), 'does-not-exist-phi') })).toThrow(
    'does not exist',
  );
});

test('rejects an invalid PORT', () => {
  expect(() => loadConfig({ PORT: 'abc', PROJECT_ROOT: tmpdir() })).toThrow('PORT');
});
