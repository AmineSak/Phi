import { useEffect, useRef, useState } from 'react';
import { Play, TriangleAlert } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';

import { pdfPathFor } from '@phi/shared';

import { api } from '../api/client.ts';
import { compile, goToSource } from '../editor/session.ts';
import { NoPdfError, renderPdf } from '../pdf/render.ts';
import { flashBox, pdfPointAt } from '../pdf/synctex.ts';
import { useCompileStore } from '../store/compile-store.ts';

const PADDING_PX = 24;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
type ViewState = 'loading' | 'ready' | 'none' | 'error';

/** Width of `el` in CSS pixels, updated (debounced) on resize. */
function useWidth(el: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el.current) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(([entry]) => {
      clearTimeout(timer);
      timer = setTimeout(() => setWidth(Math.floor(entry?.contentRect.width ?? 0)), 120);
    });
    observer.observe(el.current);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [el]);
  return width;
}

export function PdfViewer() {
  const pdfVersion = useCompileStore((s) => s.pdfVersion);
  const pdfBuild = useCompileStore((s) => s.pdfBuild);
  const root = useCompileStore((s) => s.root);
  const rootError = useCompileStore((s) => s.rootError);
  const shownRoot = useRef<string | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const width = useWidth(frame);
  const [state, setState] = useState<ViewState>('loading');
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState('');
  const highlight = useCompileStore((s) => s.pdfHighlight);
  const syncError = useCompileStore((s) => s.syncError);
  const scroller = () =>
    frame.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null;

  // "Show in PDF": scroll to the box and flash it, once the PDF is on screen.
  useEffect(() => {
    if (!highlight || state !== 'ready' || !pages.current) return;
    flashBox(pages.current, scroller(), highlight.box);
  }, [highlight, state]);

  useEffect(() => {
    const target = pages.current;
    if (!width || !target || !root) return;
    const controller = new AbortController();
    const build = useCompileStore.getState().build;
    // Another root's PDF must not linger as if it were this one's.
    const sameRoot = shownRoot.current === root;
    if (!sameRoot) target.replaceChildren();
    setState((s) => (s === 'ready' && sameRoot ? s : 'loading'));

    renderPdf(
      api.pdfUrl(root, pdfVersion),
      Math.max(width - PADDING_PX * 2, 200),
      controller.signal,
    )
      .then((result) => {
        if (!result) return;
        // Keep the reader on the same spot: restore the scroll position as a fraction.
        const viewport = frame.current?.querySelector<HTMLElement>(
          '[data-slot="scroll-area-viewport"]',
        );
        const ratio =
          viewport && viewport.scrollHeight > 0 ? viewport.scrollTop / viewport.scrollHeight : 0;
        target.replaceChildren(result.element);
        shownRoot.current = root;
        if (viewport) viewport.scrollTop = ratio * viewport.scrollHeight;
        setPageCount(result.pages);
        setState('ready');
        useCompileStore.setState({ pdfBuild: build });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof NoPdfError) {
          // Keep showing the last good PDF when a failed build produced none.
          setState((s) => (s === 'ready' && sameRoot ? s : 'none'));
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
        setState('error');
      });
    return () => controller.abort();
  }, [pdfVersion, width, root]);

  return (
    <section aria-label="PDF preview" className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-9 shrink-0 items-center gap-3 overflow-hidden border-b bg-card px-3 text-xs whitespace-nowrap text-muted-foreground">
        <span className="font-semibold text-foreground" title={root ? pdfPathFor(root) : undefined}>
          {root ? pdfPathFor(root).slice(pdfPathFor(root).lastIndexOf('/') + 1) : 'PDF'}
        </span>
        {state === 'ready' && (
          <>
            <span>{pdfBuild ? `Build ${pdfBuild}` : 'Earlier build'}</span>
            <span>
              {pageCount} {pageCount === 1 ? 'page' : 'pages'}
            </span>
          </>
        )}
        {state === 'loading' && <Spinner className="ml-auto" />}
      </header>
      <div ref={frame} className="relative min-h-0 flex-1">
        <ScrollArea className="h-full">
          {/* Dark mode dims the white sheet for long sessions; light mode shows it as printed. */}
          {/* Cmd/Ctrl+click jumps to the source (SPEC 6.4). */}
          <div
            ref={pages}
            className="py-6 dark:[&_canvas]:brightness-90"
            style={{ paddingInline: PADDING_PX }}
            title={`${isMac ? '⌘' : 'Ctrl'}+click to jump to the source`}
            onClick={(e) => {
              if (!(e.metaKey || e.ctrlKey) || !root) return;
              const point = pdfPointAt(e.nativeEvent);
              if (point) void goToSource(pdfPathFor(root), point.page, point.x, point.y);
            }}
          />
        </ScrollArea>
        {syncError && (
          <div className="absolute inset-x-0 top-0 z-10 p-3">
            <Alert>
              <TriangleAlert />
              <AlertTitle>SyncTeX</AlertTitle>
              <AlertDescription>{syncError}</AlertDescription>
            </Alert>
          </div>
        )}
        {!root && rootError && (
          <div className="absolute inset-x-0 top-0 p-3">
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>No file to compile</AlertTitle>
              <AlertDescription>{rootError}</AlertDescription>
            </Alert>
          </div>
        )}
        {root && state === 'none' && (
          <Empty className="absolute inset-0 bg-background">
            <EmptyHeader>
              <EmptyTitle>No PDF yet</EmptyTitle>
              <EmptyDescription>Compile the project to see the document here.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button size="sm" onClick={() => void compile()}>
                <Play />
                Compile
              </Button>
            </EmptyContent>
          </Empty>
        )}
        {state === 'error' && (
          <div className="absolute inset-x-0 top-0 p-3">
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>Could not show the PDF</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        )}
      </div>
    </section>
  );
}
