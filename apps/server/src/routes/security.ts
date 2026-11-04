import type { ApiError, ExistsErrorBody, FileConflictError } from '@phi/shared';

import { ConflictError, ExistsError } from '../services/fs.ts';
import { PathError } from '../services/paths.ts';
import { RootError } from '../services/root-file.ts';
import { UploadError } from '../services/upload.ts';

export type Handler = (req: Request) => Response | Promise<Response>;

/** Thrown by handlers for bad input; becomes a JSON error with this status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const error = (status: number, message: string) =>
  Response.json({ error: message } satisfies ApiError, { status });

function isLocal(value: string, port: number): boolean {
  return value === `127.0.0.1:${port}` || value === `localhost:${port}`;
}

/**
 * The Host check blocks DNS rebinding: a page on evil.com re-pointed at 127.0.0.1 makes
 * same-origin requests, which carry no Origin header but keep Host: evil.com.
 */
export function isAllowed(req: Request, port: number): boolean {
  const origin = req.headers.get('origin');
  if (
    origin !== null &&
    origin !== `http://127.0.0.1:${port}` &&
    origin !== `http://localhost:${port}`
  ) {
    return false;
  }
  return isLocal(new URL(req.url).host, port);
}

/** Wraps an /api handler: rejects foreign origins and turns thrown errors into JSON responses. */
export function guard(handler: Handler, port: number): Handler {
  return async (req) => {
    if (!isAllowed(req, port)) return error(403, 'Forbidden origin');
    try {
      return await handler(req);
    } catch (err) {
      return toResponse(err);
    }
  };
}

function toResponse(err: unknown): Response {
  if (err instanceof ConflictError) {
    const body: FileConflictError = { error: 'conflict', path: err.path, mtimeMs: err.mtimeMs };
    return Response.json(body, { status: 409 });
  }
  if (err instanceof ExistsError) {
    const body: ExistsErrorBody = { error: 'exists', message: err.message, path: err.path };
    return Response.json(body, { status: 409 });
  }
  if (err instanceof PathError || err instanceof URIError || err instanceof RootError) {
    return error(400, err.message);
  }
  if (err instanceof UploadError) return error(err.status, err.message);
  if (err instanceof HttpError) return error(err.status, err.message);
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT') {
    const message =
      err instanceof Error && err.message.startsWith('File not found')
        ? err.message
        : 'File not found';
    return error(404, message);
  }
  if (code === 'EISDIR') return error(400, 'Path is a directory');

  console.error(err instanceof Error ? err.stack : err);
  return error(500, err instanceof Error ? err.message : String(err));
}
