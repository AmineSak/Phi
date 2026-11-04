import type { HealthResponse } from '@phi/shared';

export function health(projectRoot: string | null): Response {
  return Response.json({ ok: true, app: 'phi', projectRoot } satisfies HealthResponse);
}
