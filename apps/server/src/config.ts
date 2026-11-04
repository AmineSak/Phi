import { statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  port: number;
  /** PROJECT_ROOT, if set: the project opened at startup. The open project is runtime state (project.ts). */
  initialProjectRoot: string | null;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got "${env.PORT}"`);
  }

  if (!env.PROJECT_ROOT) return { port, initialProjectRoot: null };
  const projectRoot = resolve(env.PROJECT_ROOT);
  if (!statSync(projectRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`PROJECT_ROOT folder does not exist: ${projectRoot}`);
  }
  return { port, initialProjectRoot: projectRoot };
}
