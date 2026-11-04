import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PathError, resolveInProject } from '../paths.ts';

let base: string;
let root: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'paths-test-'));
  root = join(base, 'project');
  const outside = join(base, 'outside');
  mkdirSync(join(root, 'chapters'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, 'main.tex'), '');
  writeFileSync(join(root, 'chapters', 'intro.tex'), '');
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'));
  symlinkSync(outside, join(root, 'leakdir'));
  symlinkSync(join(root, 'main.tex'), join(root, 'alias.tex'));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('resolveInProject', () => {
  test('resolves files inside the project', () => {
    expect(resolveInProject(root, 'main.tex')).toBe(join(root, 'main.tex'));
    expect(resolveInProject(root, 'chapters/intro.tex')).toBe(join(root, 'chapters', 'intro.tex'));
    expect(resolveInProject(root, './chapters/./intro.tex')).toBe(
      join(root, 'chapters', 'intro.tex'),
    );
  });

  test('resolves files that do not exist yet', () => {
    expect(resolveInProject(root, 'new/dir/file.tex')).toBe(join(root, 'new', 'dir', 'file.tex'));
  });

  test('allows symlinks that stay inside the project', () => {
    expect(resolveInProject(root, 'alias.tex')).toBe(join(root, 'alias.tex'));
  });

  test('rejects absolute paths', () => {
    expect(() => resolveInProject(root, '/etc/passwd')).toThrow(PathError);
    expect(() => resolveInProject(root, join(root, 'main.tex'))).toThrow('relative');
  });

  test('rejects ".." segments, even when they would stay inside', () => {
    expect(() => resolveInProject(root, '../outside/secret.txt')).toThrow('".."');
    expect(() => resolveInProject(root, 'chapters/../main.tex')).toThrow('".."');
    expect(() => resolveInProject(root, 'chapters\\..\\..\\x')).toThrow('".."');
  });

  test('allows names that merely contain dots', () => {
    expect(resolveInProject(root, '..hidden')).toBe(join(root, '..hidden'));
  });

  test('rejects null bytes', () => {
    expect(() => resolveInProject(root, 'main.tex\0.png')).toThrow('null byte');
  });

  test('rejects a symlinked file pointing outside', () => {
    expect(() => resolveInProject(root, 'leak.txt')).toThrow('symlink');
  });

  test('rejects paths through a symlinked dir pointing outside, existing or not', () => {
    expect(() => resolveInProject(root, 'leakdir/secret.txt')).toThrow('symlink');
    expect(() => resolveInProject(root, 'leakdir/new.txt')).toThrow('symlink');
  });
});

describe('app data (.latex-agent)', () => {
  test('is refused unless allowAppData, in any case and with ./ prefixes', () => {
    for (const p of [
      '.latex-agent',
      '.latex-agent/settings.json',
      './.latex-agent/trash/x',
      '.LaTeX-Agent/a',
    ]) {
      expect(() => resolveInProject(root, p)).toThrow('app');
    }
    expect(resolveInProject(root, '.latex-agent/settings.json', { allowAppData: true })).toBe(
      join(root, '.latex-agent', 'settings.json'),
    );
  });

  test('a file merely named like it, deeper in the tree, is fine', () => {
    expect(resolveInProject(root, 'notes/.latex-agent')).toBe(join(root, 'notes', '.latex-agent'));
  });
});
