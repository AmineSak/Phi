import { mkdir, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type {
  CreateProjectRequest,
  ProjectResponse,
  ProjectsResponse,
  TemplateInfo,
} from '@phi/shared';
import { zipSync, type Zippable } from 'fflate';

import type { Projects } from '../project.ts';
import { listFiles } from '../services/fs.ts';
import { isAppDataPath, PathError, resolveInProject } from '../services/paths.ts';
import type { SettingsStore } from '../services/settings.ts';
import { copyTemplate, listTemplates, TemplateConflictError } from '../services/templates.ts';
import { HttpError } from './security.ts';

/** Letters, digits, spaces, dots, dashes and underscores; no leading dot (SPEC 9.2). */
const PROJECT_NAME = /^[A-Za-z0-9 _-][A-Za-z0-9 ._-]{0,63}$/;

async function body<T>(req: Request): Promise<Partial<T>> {
  const value: unknown = await req.json().catch(() => {
    throw new HttpError(400, 'Body must be JSON');
  });
  if (typeof value !== 'object' || value === null)
    throw new HttpError(400, 'Body must be an object');
  return value as Partial<T>;
}

/**
 * SPEC 4.4: the open project and recent ones; opening another stops all agent work.
 * Deployed (SPEC 9.2), projects are the folders of `projects.projectsDir`, created from a
 * template here, and a project downloads as a .zip.
 */
export function projectHandlers(
  projects: Projects,
  settings: SettingsStore,
  templatesDir?: string,
) {
  const managed = projects.projectsDir;
  const describe = async (): Promise<ProjectResponse> => ({
    root: projects.root(),
    recent: (await settings.read()).recentProjects,
    managed: managed !== null,
  });
  const requireManaged = (): string => {
    if (!managed) throw new HttpError(404, 'Projects are opened by folder here, not created');
    return managed;
  };

  return {
    /** GET /api/project */
    get: async () => Response.json(await describe()),

    /** POST /api/project { path }: an absolute path to an existing folder. */
    open: async (req: Request) => {
      await projects.open((await body<{ path: string }>(req)).path);
      return Response.json(await describe());
    },

    /** GET /api/templates */
    templates: () =>
      Response.json(
        listTemplates(templatesDir).map(
          ({ id, name, description }) => ({ id, name, description }) satisfies TemplateInfo,
        ),
      ),

    /** GET /api/projects: the project folders, by name. */
    list: async () => {
      const dir = requireManaged();
      const entries = await readdir(dir, { withFileTypes: true });
      const response: ProjectsResponse = {
        projects: entries
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => ({ name: e.name, path: join(dir, e.name) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
      return Response.json(response);
    },

    /** POST /api/projects { name, template }: a new folder from a template, then opened. */
    create: async (req: Request) => {
      const dir = requireManaged();
      const { name, template } = await body<CreateProjectRequest>(req);
      if (typeof name !== 'string' || !PROJECT_NAME.test(name.trim())) {
        throw new HttpError(
          400,
          'Name it with letters, digits, spaces, dots, dashes or underscores (at most 64)',
        );
      }
      const chosen = listTemplates(templatesDir).find((t) => t.id === template);
      if (!chosen) throw new HttpError(400, `No template "${String(template)}"`);
      const path = join(dir, name.trim());
      try {
        await mkdir(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new HttpError(409, `A project named "${name.trim()}" already exists`);
        }
        throw err;
      }
      try {
        copyTemplate(chosen, path);
      } catch (err) {
        if (err instanceof TemplateConflictError) throw new HttpError(409, err.message);
        throw err;
      }
      await projects.open(path);
      return Response.json(await describe(), { status: 201 });
    },

    /** GET /api/project/archive: the open project as a .zip, without Phi's app data. */
    archive: async () => {
      const root = projects.current().root;
      const files: Zippable = {};
      for (const entry of await listFiles(root)) {
        if (entry.isDir || isAppDataPath(entry.path)) continue;
        let absolute: string;
        try {
          absolute = resolveInProject(root, entry.path);
        } catch (err) {
          // A symlink leading out of the project: its target is not the project's to share.
          if (err instanceof PathError) continue;
          throw err;
        }
        files[entry.path] = new Uint8Array(await readFile(absolute));
      }
      const name = basename(root).replace(/[^A-Za-z0-9 ._-]/g, '_') || 'project';
      return new Response(zipSync(files, { level: 6 }), {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${name}.zip"`,
          'cache-control': 'no-store',
        },
      });
    },
  };
}
