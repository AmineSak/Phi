import {
  pdfPathFor,
  type CompileRequest,
  type RootResponse,
  type SynctexBox,
  type SynctexSource,
} from '@phi/shared';

import { compileProject } from '../services/project-compile.ts';
import { resolveInProject } from '../services/paths.ts';
import { resolveRoot } from '../services/root-file.ts';
import { SynctexError, synctexEdit, synctexView } from '../services/synctex.ts';
import { HttpError } from './security.ts';

async function parseCompileRequest(req: Request): Promise<CompileRequest> {
  const text = await req.text();
  if (!text.trim()) return {};
  const body = JSON.parse(text) as unknown;
  const activeFile = (body as { activeFile?: unknown } | null)?.activeFile;
  if (activeFile !== undefined && activeFile !== null && typeof activeFile !== 'string') {
    throw new HttpError(400, '"activeFile" must be a path');
  }
  return activeFile ? { activeFile } : {};
}

/** A required finite number from the query string. */
function numberParam(params: URLSearchParams, name: string, fallback?: number): number {
  const raw = params.get(name);
  if (raw === null && fallback !== undefined) return fallback;
  const value = Number(raw);
  if (raw === null || raw === '' || !Number.isFinite(value)) {
    throw new HttpError(400, `"${name}" must be a number`);
  }
  return value;
}

/** SyncTeX failures are the user's situation (no compile yet, no match), not server errors. */
async function synctex<T>(run: () => Promise<T>): Promise<Response> {
  try {
    return Response.json(await run());
  } catch (err) {
    if (err instanceof SynctexError) throw new HttpError(400, err.message);
    throw err;
  }
}

export function compileHandlers(root: string) {
  return {
    /**
     * POST /api/compile { activeFile? }: compiles the root resolved from the active file
     * (SPEC 4.3) and returns the result with the root it used.
     */
    compile: async (req: Request) => {
      const { activeFile } = await parseCompileRequest(req).catch((err: unknown) => {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, 'Body must be JSON');
      });
      const { root: rootFile } = await resolveRoot(root, activeFile);
      return Response.json(await compileProject(root, rootFile));
    },

    /** GET /api/root?activeFile=…: the root that would be compiled, without compiling. */
    root: async (req: Request) => {
      const activeFile = new URL(req.url).searchParams.get('activeFile') || undefined;
      return Response.json((await resolveRoot(root, activeFile)) satisfies RootResponse);
    },

    /**
     * GET /api/synctex/edit?page&x&y[&pdf]: the source line at a spot in the PDF (SPEC 6.4).
     * x and y are PDF points from the page's top-left; pdf defaults to the project root's PDF.
     */
    synctexEdit: async (req: Request) => {
      const params = new URL(req.url).searchParams;
      const page = numberParam(params, 'page');
      const x = numberParam(params, 'x');
      const y = numberParam(params, 'y');
      const pdf = params.get('pdf') || pdfPathFor((await resolveRoot(root)).root);
      return synctex<SynctexSource>(() => synctexEdit(root, pdf, page, x, y));
    },

    /**
     * GET /api/synctex/view?file&line[&column][&pdf]: where a source line is in the PDF.
     * pdf defaults to the PDF of the root `file` compiles under (SPEC 4.3).
     */
    synctexView: async (req: Request) => {
      const params = new URL(req.url).searchParams;
      const file = params.get('file');
      if (!file) throw new HttpError(400, '"file" is required');
      const line = numberParam(params, 'line');
      const column = numberParam(params, 'column', 0);
      const pdf = params.get('pdf') || pdfPathFor((await resolveRoot(root, file)).root);
      return synctex<SynctexBox>(() => synctexView(root, file, line, column, pdf));
    },

    /** GET /api/pdf?root=thesis/thesis.tex: the PDF next to that root (default: resolved root). */
    pdf: async (req: Request) => {
      const requested = new URL(req.url).searchParams.get('root');
      const rootFile = requested || (await resolveRoot(root)).root;
      if (!/\.(tex|ltx|latex)$/i.test(rootFile)) {
        throw new HttpError(400, '"root" must be a .tex file');
      }
      const pdf = pdfPathFor(rootFile);
      const file = Bun.file(resolveInProject(root, pdf));
      if (!(await file.exists())) {
        return Response.json(
          { error: `No PDF yet for ${rootFile}; compile first` },
          { status: 404 },
        );
      }
      return new Response(file, {
        headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store' },
      });
    },
  };
}
