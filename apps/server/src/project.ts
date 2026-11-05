// The open project (SPEC 4.4) is runtime state: nothing captures its root at import time.
// Everything that depends on the root lives in one context, rebuilt when the project changes.

import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import type { Llm } from './agent/llm.ts';
import { createThreads, type Threads } from './agent/threads.ts';
import { agentHandlers } from './routes/agent.ts';
import { compileHandlers } from './routes/compile.ts';
import { fileHandlers } from './routes/files.ts';
import { HttpError } from './routes/security.ts';
import type { SettingsStore } from './services/settings.ts';

export interface ProjectContext {
  root: string;
  threads: Threads;
  files: ReturnType<typeof fileHandlers>;
  compile: ReturnType<typeof compileHandlers>;
  agent: ReturnType<typeof agentHandlers>;
}

/** The path can't be opened as a project (400). */
export class ProjectPathError extends HttpError {
  constructor(message: string) {
    super(400, message);
  }
}

/**
 * A project folder: absolute, existing, a directory. Returns it normalized. With `projectsDir`
 * (deployed, SPEC 9.2) it must also be a folder directly inside it, symlinks resolved, so no
 * other folder of the server can be opened.
 */
export async function checkProjectPath(
  path: unknown,
  projectsDir: string | null = null,
): Promise<string> {
  if (typeof path !== 'string' || !path.trim()) throw new ProjectPathError('"path" is required');
  if (!isAbsolute(path))
    throw new ProjectPathError(`Use an absolute path, e.g. /Users/you/thesis (got "${path}")`);
  const root = resolve(path);
  const info = await stat(root).catch(() => null);
  if (!info) throw new ProjectPathError(`${root} does not exist`);
  if (!info.isDirectory()) throw new ProjectPathError(`${root} is not a folder`);
  if (projectsDir && dirname(await realpath(root)) !== (await realpath(projectsDir))) {
    throw new ProjectPathError(`${root} is not one of the projects in ${projectsDir}`);
  }
  return root;
}

export type Projects = ReturnType<typeof createProjects>;

export function createProjects({
  initialRoot,
  llm,
  settings,
  projectsDir = null,
  onSwitch = () => {},
}: {
  initialRoot: string | null;
  llm: Llm;
  settings: SettingsStore;
  /** When set, only its folders can be opened (SPEC 9.2). */
  projectsDir?: string | null;
  /** Called once the old project is closed, before the new one is served. */
  onSwitch?: () => void;
}) {
  const build = (root: string): ProjectContext => {
    const threads = createThreads({ projectRoot: root, llm });
    return {
      root,
      threads,
      files: fileHandlers(root),
      compile: compileHandlers(root),
      agent: agentHandlers(threads, llm, root),
    };
  };

  let current: ProjectContext | null = initialRoot ? build(initialRoot) : null;
  let switching: Promise<void> = Promise.resolve();

  return {
    /** The open project's context; 409 when none is open yet. */
    current(): ProjectContext {
      if (!current) throw new HttpError(409, 'No project is open. Open one with its folder path.');
      return current;
    },

    root: (): string | null => current?.root ?? null,

    projectsDir,

    /**
     * Opens `path`: stops every run and pending review of the current project, then serves the
     * new one with fresh threads, and records it as the most recent project.
     */
    open(path: unknown): Promise<string> {
      const result = switching.then(async () => {
        const root = await checkProjectPath(path, projectsDir);
        if (current?.root !== root) {
          await current?.threads.closeAll();
          onSwitch();
          current = build(root);
        }
        await settings.addRecentProject(root);
        return root;
      });
      switching = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
