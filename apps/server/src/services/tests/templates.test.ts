import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  copyTemplate,
  listTemplates,
  TemplateConflictError,
  templateFiles,
  type Template,
} from '../templates.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'phi-templates-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('templates', () => {
  test('the bundled ones: blank, beamer, paper, thesis, each with a main.tex', () => {
    const templates = listTemplates();
    expect(templates.map((t) => t.id)).toEqual(['blank', 'beamer', 'paper', 'thesis']);
    for (const t of templates) {
      expect(templateFiles(t)).toContain('main.tex');
      expect(templateFiles(t)).not.toContain('template.json');
      expect(readFileSync(join(t.dir, 'main.tex'), 'utf8')).toContain('\\documentclass');
    }
  });

  const make = (files: Record<string, string>): Template => {
    const tdir = join(dir, 'tpl');
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(tdir, path, '..'), { recursive: true });
      writeFileSync(join(tdir, path), content);
    }
    return { id: 'tpl', name: 'T', description: '', dir: tdir };
  };

  test('listing: sorted by order then name; folders without template.json are skipped', () => {
    const root = join(dir, 'templates');
    for (const [id, meta] of [
      ['zeta', { name: 'Zeta', order: 1 }],
      ['alpha', { name: 'Alpha' }],
      ['beta', { name: 'Beta', order: 2, description: 'b' }],
    ] as const) {
      mkdirSync(join(root, id), { recursive: true });
      writeFileSync(join(root, id, 'template.json'), JSON.stringify(meta));
    }
    mkdirSync(join(root, 'downloads'));
    expect(listTemplates(root).map((t) => [t.id, t.description])).toEqual([
      ['zeta', ''],
      ['beta', 'b'],
      ['alpha', ''],
    ]);
    expect(listTemplates(join(dir, 'missing'))).toEqual([]);
  });

  test('copies files and subfolders into a new folder, without the manifest', () => {
    const t = make({
      'template.json': '{}',
      'main.tex': 'main',
      'chapters/one.tex': 'one',
      '.DS_Store': 'x',
    });
    const dest = join(dir, 'new', 'project');
    expect(copyTemplate(t, dest)).toEqual(['chapters/one.tex', 'main.tex']);
    expect(readFileSync(join(dest, 'chapters/one.tex'), 'utf8')).toBe('one');
    expect(existsSync(join(dest, 'template.json'))).toBe(false);
    expect(existsSync(join(dest, '.DS_Store'))).toBe(false);
  });

  test('never overwrites: a conflict copies nothing at all', () => {
    const t = make({ 'main.tex': 'new', 'refs.bib': 'new' });
    const dest = join(dir, 'existing');
    mkdirSync(dest);
    writeFileSync(join(dest, 'main.tex'), 'mine');
    writeFileSync(join(dest, 'notes.txt'), 'keep');
    expect(() => copyTemplate(t, dest)).toThrow(TemplateConflictError);
    expect(readFileSync(join(dest, 'main.tex'), 'utf8')).toBe('mine');
    expect(existsSync(join(dest, 'refs.bib'))).toBe(false);
    // Unrelated files don't block it.
    rmSync(join(dest, 'main.tex'));
    expect(copyTemplate(t, dest)).toEqual(['main.tex', 'refs.bib']);
    expect(readFileSync(join(dest, 'notes.txt'), 'utf8')).toBe('keep');
  });
});
