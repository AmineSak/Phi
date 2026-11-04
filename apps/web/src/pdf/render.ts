// Renders a PDF's pages as canvases. No React here; PdfViewer owns the container.

import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';

GlobalWorkerOptions.workerSrc = '/pdf.worker.mjs';

/** Thrown when the server has no PDF yet (never compiled). */
export class NoPdfError extends Error {}

const PAGE_GAP_PX = 16;

/**
 * Renders every page of the PDF at `url` into a new element, fitted to `width` CSS pixels,
 * and resolves with it once all pages are drawn, so the caller can swap it in without flicker.
 * Resolves null if `signal` aborts first.
 */
export async function renderPdf(
  url: string,
  width: number,
  signal: AbortSignal,
): Promise<{ element: HTMLElement; pages: number } | null> {
  const response = await fetch(url, { cache: 'no-store', signal });
  if (response.status === 404) throw new NoPdfError('No PDF yet');
  if (!response.ok) throw new Error(`Could not load the PDF (${response.status})`);
  const data = new Uint8Array(await response.arrayBuffer());

  const task = getDocument({ data });
  signal.addEventListener('abort', () => void task.destroy(), { once: true });
  const pdf = await task.promise;
  try {
    const element = document.createElement('div');
    element.style.display = 'flex';
    element.style.flexDirection = 'column';
    element.style.alignItems = 'center';
    element.style.gap = `${PAGE_GAP_PX}px`;
    const dpr = window.devicePixelRatio || 1;

    for (let n = 1; n <= pdf.numPages; n++) {
      if (signal.aborted) return null;
      const page = await pdf.getPage(n);
      // At scale 1 a viewport is in PDF points, the unit SyncTeX uses.
      const points = page.getViewport({ scale: 1 });
      const scale = width / points.width;
      const viewport = page.getViewport({ scale: scale * dpr });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
      canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
      canvas.style.display = 'block';
      canvas.setAttribute('aria-label', `Page ${n} of ${pdf.numPages}`);
      await page.render({ canvas, viewport }).promise;
      // The page box carries its size in points, so clicks and SyncTeX boxes can be mapped.
      const box = document.createElement('div');
      box.style.position = 'relative';
      box.dataset.page = String(n);
      box.dataset.widthPt = String(points.width);
      box.dataset.heightPt = String(points.height);
      box.append(canvas);
      element.append(box);
    }
    return signal.aborted ? null : { element, pages: pdf.numPages };
  } finally {
    await task.destroy();
  }
}
