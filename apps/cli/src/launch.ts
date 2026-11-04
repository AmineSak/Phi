// Serving a project: reuse a Phi server already running on the port (switching it to the
// project), else start one, then open the browser on it.

import { join } from 'node:path';

import type { HealthResponse, OpenProjectRequest } from '@phi/shared';

const REPO = join(import.meta.dir, '../../..');
export const SERVER_ENTRY = join(REPO, 'apps/server/src/index.ts');

/** Who answers on a port: a Phi server, nothing, or something else. */
export type PortState = 'phi' | 'free' | 'taken';

export async function probe(port: number): Promise<PortState> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    const body = (await res.json().catch(() => null)) as Partial<HealthResponse> | null;
    return body?.app === 'phi' ? 'phi' : 'taken';
  } catch (err) {
    // Refused: nobody listens. A timeout means something holds the port without answering.
    return err instanceof Error && err.name === 'TimeoutError' ? 'taken' : 'free';
  }
}

/** The first port from `start` that is free or already runs Phi. */
export async function choosePort(
  start: number,
  tries = 20,
): Promise<{ port: number; running: boolean }> {
  for (let port = start; port < start + tries; port++) {
    const state = await probe(port);
    if (state !== 'taken') return { port, running: state === 'phi' };
  }
  throw new Error(`Ports ${start}-${start + tries - 1} are all in use by other programs.`);
}

/** Tells a running Phi server to open `root` (it stops agent work in the current project). */
export async function openOnRunning(port: number, root: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/api/project`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: root } satisfies OpenProjectRequest),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `The server refused to open ${root} (${res.status})`);
  }
}

/**
 * Starts the server for `root` on `port`. It runs from the repo, so bunfig.toml (Tailwind) and
 * the .env with the API key apply wherever `phi` is typed.
 */
export function startServer(port: number, root: string): Bun.Subprocess {
  return Bun.spawn([process.execPath, SERVER_ENTRY], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), PROJECT_ROOT: root },
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
}

/** Resolves once Phi answers on `port`; throws if `server` exits first or after `timeoutMs`. */
export async function waitUntilUp(
  port: number,
  server: Bun.Subprocess,
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();
  while ((await probe(port)) !== 'phi') {
    // A process killed by a signal keeps exitCode null: check both.
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`The server stopped (${server.signalCode ?? `exit ${server.exitCode}`}).`);
    }
    if (Date.now() - start > timeoutMs) throw new Error('The server did not start in time.');
    await Bun.sleep(150);
  }
}

/** The command that opens a URL in the default browser on this platform. */
export function browserCommand(url: string, platform = process.platform): string[] {
  if (platform === 'darwin') return ['open', url];
  if (platform === 'win32') return ['cmd', '/c', 'start', '""', url];
  return ['xdg-open', url];
}

export function openBrowser(url: string): void {
  try {
    Bun.spawn(browserCommand(url), { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  } catch {
    // No opener (a headless machine): the URL is printed anyway.
  }
}
