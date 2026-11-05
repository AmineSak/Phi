import { statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  port: number;
  /** Interface to listen on: 127.0.0.1 unless HOST is set (the container, behind IAP). */
  host: string;
  /** PROJECT_ROOT, if set: the project opened at startup. The open project is runtime state (project.ts). */
  initialProjectRoot: string | null;
  /** PUBLIC_ORIGIN, e.g. https://phi.example.com: the address browsers use when deployed. */
  publicOrigin: string | null;
  /** PROJECTS_DIR: when set, projects are the folders in it, created from the browser (SPEC 9.2). */
  projectsDir: string | null;
  /** IAP_AUDIENCE and ALLOWED_EMAIL: every request needs Google IAP's signed header (SPEC 9.1). */
  iap: { audience: string; allowedEmail: string | null } | null;
  /** NODE_ENV=production: the web app is bundled once, minified, without hot reload. */
  production: boolean;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

function existingFolder(value: string, name: string): string {
  const path = resolve(value);
  if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${name} folder does not exist: ${path}`);
  }
  return path;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got "${env.PORT}"`);
  }

  const host = env.HOST || '127.0.0.1';
  const iap = env.IAP_AUDIENCE
    ? { audience: env.IAP_AUDIENCE, allowedEmail: env.ALLOWED_EMAIL?.toLowerCase() || null }
    : null;
  // There is no login of Phi's own: off the loopback interface, IAP is the login.
  if (!LOOPBACK.has(host) && !iap && env.ALLOW_NO_AUTH !== '1') {
    throw new Error(
      `HOST=${host} exposes Phi beyond this machine, and Phi has no login of its own. ` +
        'Set IAP_AUDIENCE (Google IAP in front of it), or ALLOW_NO_AUTH=1 for a container ' +
        'published only on 127.0.0.1.',
    );
  }

  let publicOrigin: string | null = null;
  if (env.PUBLIC_ORIGIN) {
    const url = new URL(env.PUBLIC_ORIGIN);
    if (url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`PUBLIC_ORIGIN must be an origin like https://phi.example.com`);
    }
    publicOrigin = url.origin;
  }

  return {
    port,
    host,
    initialProjectRoot: env.PROJECT_ROOT ? existingFolder(env.PROJECT_ROOT, 'PROJECT_ROOT') : null,
    publicOrigin,
    projectsDir: env.PROJECTS_DIR ? existingFolder(env.PROJECTS_DIR, 'PROJECTS_DIR') : null,
    iap,
    production: env.NODE_ENV === 'production',
  };
}
