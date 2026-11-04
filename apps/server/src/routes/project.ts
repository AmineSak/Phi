import type { ProjectResponse } from '@phi/shared';

import type { Projects } from '../project.ts';
import type { SettingsStore } from '../services/settings.ts';
import { HttpError } from './security.ts';

/** SPEC 4.4: the open project and recent ones; opening another stops all agent work. */
export function projectHandlers(projects: Projects, settings: SettingsStore) {
  const describe = async (): Promise<ProjectResponse> => ({
    root: projects.root(),
    recent: (await settings.read()).recentProjects,
  });

  return {
    /** GET /api/project */
    get: async () => Response.json(await describe()),

    /** POST /api/project { path }: an absolute path to an existing folder. */
    open: async (req: Request) => {
      const body = (await req.json().catch(() => {
        throw new HttpError(400, 'Body must be JSON');
      })) as { path?: unknown } | null;
      await projects.open(body?.path);
      return Response.json(await describe());
    },
  };
}
