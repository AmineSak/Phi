import type { ApiError, ExistsErrorBody, FileConflictError } from '@phi/shared';

import { ConflictError, ExistsError } from '../services/fs.ts';
import { IAP_HEADER, IapError, type IapVerifier } from '../services/iap.ts';
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

/**
 * Who may call the API. Locally just the port (127.0.0.1 and localhost on it); deployed, also
 * the public origin, behind IAP (SPEC 9.1).
 */
export interface Access {
  port: number;
  publicOrigin?: string | null;
  iap?: IapVerifier | null;
}

const policy = (access: number | Access): Access =>
  typeof access === 'number' ? { port: access } : access;

/**
 * The Host check blocks DNS rebinding: a page on evil.com re-pointed at 127.0.0.1 makes
 * same-origin requests, which carry no Origin header but keep Host: evil.com.
 */
export function isAllowed(req: Request, access: number | Access): boolean {
  const { port, publicOrigin } = policy(access);
  const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (publicOrigin) {
    origins.push(publicOrigin);
    hosts.push(new URL(publicOrigin).host);
  }
  const origin = req.headers.get('origin');
  if (origin !== null && !origins.includes(origin)) return false;
  return hosts.includes(new URL(req.url).host);
}

/** The origin and, when deployed, the IAP checks; a JSON error response when refused. */
export async function refusal(req: Request, access: number | Access): Promise<Response | null> {
  const { iap } = policy(access);
  if (iap) {
    try {
      await iap(req.headers.get(IAP_HEADER));
    } catch (err) {
      if (err instanceof IapError) return error(err.status, err.message);
      throw err;
    }
  }
  return isAllowed(req, access) ? null : error(403, 'Forbidden origin');
}

/** Wraps an /api handler: refuses foreign origins (and requests without IAP's token when
 * deployed), and turns thrown errors into JSON responses. */
export function guard(handler: Handler, access: number | Access): Handler {
  return async (req) => {
    try {
      return (await refusal(req, access)) ?? (await handler(req));
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
