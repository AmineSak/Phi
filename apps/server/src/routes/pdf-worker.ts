import { join } from 'node:path';

// Resolved from apps/web, which owns pdfjs-dist, so the worker always matches the bundled API.
const workerPath = Bun.resolveSync(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  join(import.meta.dir, '../../../web'),
);

/** GET /pdf.worker.mjs */
export function pdfWorker(): Response {
  return new Response(Bun.file(workerPath), {
    headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
  });
}
