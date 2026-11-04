// Mapping between the rendered PDF and SyncTeX coordinates (PDF points from a page's top-left).
// No React here.

import type { SynctexBox } from '@phi/shared';

const FLASH_MS = 1600;

/** The page box (from render.ts) holding `target`, if any. */
function pageBoxOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>('[data-page]') : null;
}

/**
 * Where a click landed, in PDF points: CSS pixels relative to the page box, scaled by the
 * page's size in points over its size on screen (whatever the viewer's zoom and scroll).
 */
export function pdfPointAt(event: MouseEvent): { page: number; x: number; y: number } | null {
  const box = pageBoxOf(event.target);
  if (!box) return null;
  const rect = box.getBoundingClientRect();
  const widthPt = Number(box.dataset.widthPt);
  const heightPt = Number(box.dataset.heightPt);
  if (!rect.width || !rect.height || !widthPt || !heightPt) return null;
  return {
    page: Number(box.dataset.page),
    x: ((event.clientX - rect.left) * widthPt) / rect.width,
    y: ((event.clientY - rect.top) * heightPt) / rect.height,
  };
}

/**
 * Scrolls `viewport` so the box is in view (a third from the top) and outlines it briefly.
 * False when its page isn't rendered.
 */
export function flashBox(
  pages: HTMLElement,
  viewport: HTMLElement | null,
  box: SynctexBox,
): boolean {
  const page = pages.querySelector<HTMLElement>(`[data-page="${box.page}"]`);
  const widthPt = Number(page?.dataset.widthPt);
  if (!page || !widthPt) return false;
  const scale = page.clientWidth / widthPt; // CSS pixels per point
  const mark = document.createElement('div');
  mark.setAttribute('aria-hidden', 'true');
  Object.assign(mark.style, {
    position: 'absolute',
    left: `${box.x * scale - 3}px`,
    top: `${box.y * scale - 3}px`,
    width: `${box.width * scale + 6}px`,
    height: `${box.height * scale + 6}px`,
    borderRadius: '3px',
    background: 'color-mix(in oklch, var(--primary) 18%, transparent)',
    outline: '2px solid var(--primary)',
    pointerEvents: 'none',
    transition: 'opacity 400ms ease-out',
  });
  page.append(mark);

  if (viewport) {
    const top = mark.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    viewport.scrollTo({
      top: viewport.scrollTop + top - viewport.clientHeight / 3,
      behavior: 'smooth',
    });
  }
  setTimeout(() => {
    mark.style.opacity = '0';
    setTimeout(() => mark.remove(), 400);
  }, FLASH_MS);
  return true;
}
