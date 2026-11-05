// Project templates (SPEC 4.6, 9.2): each folder in <repo>/templates holds a template.json (name,
// description, order) and the files a new project starts with.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export const TEMPLATES_DIR = join(import.meta.dir, '../../../../templates');

/** Describes the template; not copied into projects. */
const MANIFEST = 'template.json';
const SKIPPED = new Set([MANIFEST, '.DS_Store', 'Thumbs.db']);

export interface Template {
  id: string;
  name: string;
  description: string;
  dir: string;
}

/** The templates in `dir`, by their `order` then name. */
export function listTemplates(dir = TEMPLATES_DIR): Template[] {
  if (!existsSync(dir)) return [];
  const found: (Template & { order: number })[] = [];
  for (const id of readdirSync(dir).sort()) {
    const manifest = join(dir, id, MANIFEST);
    if (!existsSync(manifest)) continue;
    const meta = JSON.parse(readFileSync(manifest, 'utf8')) as {
      name?: string;
      description?: string;
      order?: number;
    };
    found.push({
      id,
      name: meta.name ?? id,
      description: meta.description ?? '',
      order: meta.order ?? Infinity,
      dir: join(dir, id),
    });
  }
  return found
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map(({ order, ...t }) => t);
}

/** Project-relative paths of the files a template copies. */
export function templateFiles(template: Template): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (SKIPPED.has(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(relative(template.dir, path));
    }
  };
  walk(template.dir);
  return files;
}

export class TemplateConflictError extends Error {
  constructor(readonly paths: string[]) {
    super(`Already in the folder: ${paths.join(', ')}`);
  }
}

/**
 * Copies a template's files into `dest` (created if needed). Never overwrites: when any file
 * already exists, throws before copying anything. Returns the copied paths.
 */
export function copyTemplate(template: Template, dest: string): string[] {
  const files = templateFiles(template);
  const conflicts = files.filter((f) => existsSync(join(dest, f)));
  if (conflicts.length) throw new TemplateConflictError(conflicts);
  for (const file of files) {
    mkdirSync(dirname(join(dest, file)), { recursive: true });
    copyFileSync(join(template.dir, file), join(dest, file));
  }
  mkdirSync(dest, { recursive: true });
  return files;
}
