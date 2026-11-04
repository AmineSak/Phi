import {
  fileKind,
  type CreateFileRequest,
  type CreateFileResponse,
  type DeleteResponse,
  type ListFilesResponse,
  type ReadFileResponse,
  type RenameRequest,
  type RenameResponse,
  type UploadResponse,
  type WriteFileRequest,
  type WriteFileResponse,
} from '@phi/shared';

import {
  createDir,
  createFile,
  listFiles,
  readText,
  remove,
  rename,
  writeBinary,
  writeText,
} from '../services/fs.ts';
import { resolveInProject } from '../services/paths.ts';
import { HttpError } from './security.ts';

/** Project-relative path after `prefix` in the URL, with each segment URL-decoded. */
function pathAfter(req: Request, prefix: string): string {
  const path = decodeURIComponent(new URL(req.url).pathname.slice(prefix.length));
  if (!path) throw new HttpError(400, 'Missing file path');
  return path;
}

async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  const body: unknown = await req.json().catch(() => null);
  if (typeof body !== 'object' || body === null) throw new HttpError(400, 'Body must be JSON');
  return body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, `"${name}" must be a non-empty string`);
  }
  return value;
}

async function parseWriteRequest(req: Request): Promise<WriteFileRequest> {
  const { content, baseMtimeMs } = await jsonBody(req);
  if (typeof content !== 'string') throw new HttpError(400, '"content" must be a string');
  if (baseMtimeMs !== undefined && typeof baseMtimeMs !== 'number') {
    throw new HttpError(400, '"baseMtimeMs" must be a number');
  }
  return { content, baseMtimeMs };
}

async function parseCreateRequest(req: Request): Promise<CreateFileRequest> {
  const body = await jsonBody(req);
  const path = stringField(body, 'path');
  if (body.type === 'dir') return { path, type: 'dir' };
  if (body.type !== 'file') throw new HttpError(400, '"type" must be "file" or "dir"');
  if (body.content !== undefined && typeof body.content !== 'string') {
    throw new HttpError(400, '"content" must be a string');
  }
  return { path, type: 'file', content: body.content };
}

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  eps: 'application/postscript',
  pdf: 'application/pdf',
};

function contentType(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (CONTENT_TYPES[ext]) return CONTENT_TYPES[ext];
  return fileKind(path) === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream';
}

export function fileHandlers(root: string) {
  return {
    /** GET /api/files */
    list: async () => Response.json((await listFiles(root)) satisfies ListFilesResponse),

    /** GET /api/files/{path}: a text file's content. */
    read: async (req: Request) => {
      const path = pathAfter(req, '/api/files/');
      if (fileKind(path) !== 'text') {
        throw new HttpError(400, `${path} is not a text file; use /api/raw/ to fetch it`);
      }
      const { content, mtimeMs } = await readText(root, path);
      return Response.json({ path, content, mtimeMs } satisfies ReadFileResponse);
    },

    /** PUT /api/files/{path} */
    write: async (req: Request) => {
      const path = pathAfter(req, '/api/files/');
      const { content, baseMtimeMs } = await parseWriteRequest(req);
      const result = await writeText(root, path, content, baseMtimeMs);
      return Response.json(result satisfies WriteFileResponse);
    },

    /** POST /api/files { path, type: "file" | "dir", content? }: 201, or 409 if it exists. */
    create: async (req: Request) => {
      const request = await parseCreateRequest(req);
      if (request.type === 'dir') await createDir(root, request.path);
      else await createFile(root, request.path, request.content);
      return Response.json({ path: request.path } satisfies CreateFileResponse, { status: 201 });
    },

    /** POST /api/files/rename { from, to }: 409 if `to` exists. */
    rename: async (req: Request) => {
      const body = await jsonBody(req);
      const { from, to }: RenameRequest = {
        from: stringField(body, 'from'),
        to: stringField(body, 'to'),
      };
      await rename(root, from, to);
      return Response.json({ from, to } satisfies RenameResponse);
    },

    /** DELETE /api/files/{path}: moves it to .latex-agent/trash (SPEC 4.1). */
    remove: async (req: Request) => {
      const path = pathAfter(req, '/api/files/');
      const trashPath = await remove(root, path);
      return Response.json({ path, trashPath } satisfies DeleteResponse);
    },

    /** POST /api/upload/{path}?replace=1 with the raw file as body (SPEC 4.2). */
    upload: async (req: Request) => {
      const path = pathAfter(req, '/api/upload/');
      const replace = new URL(req.url).searchParams.get('replace') === '1';
      const bytes = new Uint8Array(await req.arrayBuffer());
      const { size } = await writeBinary(root, path, bytes, { replace });
      return Response.json({ path, kind: fileKind(path), size } satisfies UploadResponse, {
        status: 201,
      });
    },

    /**
     * GET /api/raw/{path}: the file's bytes with its Content-Type, never cached. An uploaded SVG
     * may contain script, so responses are sandboxed and never sniffed: opening one directly
     * can't run code with access to this app's API.
     */
    raw: async (req: Request) => {
      const path = pathAfter(req, '/api/raw/');
      const file = Bun.file(resolveInProject(root, path));
      if (!(await file.exists())) {
        throw Object.assign(new Error(`File not found: ${path}`), { code: 'ENOENT' });
      }
      return new Response(file, {
        headers: {
          'Content-Type': contentType(path),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        },
      });
    },
  };
}
