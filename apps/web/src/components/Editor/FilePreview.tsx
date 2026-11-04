import { useEffect, useRef, useState } from 'react';
import { FileQuestion, ImageOff } from 'lucide-react';
import { fileKind } from '@phi/shared';

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';

import { api } from '../../api/client.ts';
import { renderPdf } from '../../pdf/render.ts';
import { useEditorStore } from '../../store/editor-store.ts';

const PADDING_PX = 24;

function Notice({
  title,
  children,
  icon,
}: {
  title: string;
  children: React.ReactNode;
  icon: React.ReactNode;
}) {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function ImagePreview({ path, version }: { path: string; version: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [path, version]);
  if (failed) {
    return (
      <Notice title="Can't show this image" icon={<ImageOff />}>
        The browser could not display {path}. LaTeX may still be able to use it.
      </Notice>
    );
  }
  return (
    <ScrollArea className="h-full">
      <div className="flex min-h-full items-center justify-center p-6">
        {/* An <img> never runs script inside an SVG, unlike opening the file directly. */}
        <img
          src={api.rawUrl(path, version)}
          alt={path}
          onError={() => setFailed(true)}
          className="max-w-full rounded-sm bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px] shadow-sm"
        />
      </div>
    </ScrollArea>
  );
}

function PdfPreview({ path, version }: { path: string; version: number }) {
  const frame = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    const width = frame.current?.clientWidth ?? 0;
    const target = pages.current;
    if (!width || !target) return;
    const controller = new AbortController();
    setState('loading');
    renderPdf(api.rawUrl(path, version), Math.max(width - PADDING_PX * 2, 200), controller.signal)
      .then((result) => {
        if (!result) return;
        target.replaceChildren(result.element);
        setState('ready');
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setState('error');
      });
    return () => controller.abort();
  }, [path, version]);

  return (
    <div ref={frame} className="relative h-full">
      <ScrollArea className="h-full">
        <div
          ref={pages}
          className="py-6 dark:[&_canvas]:brightness-90"
          style={{ paddingInline: PADDING_PX }}
        />
      </ScrollArea>
      {state === 'loading' && <Spinner className="absolute top-3 right-3" />}
      {state === 'error' && (
        <Notice title="Can't show this PDF" icon={<FileQuestion />}>
          {error}
        </Notice>
      )}
    </div>
  );
}

/** Shows an image or PDF from the project instead of the editor (SPEC 4.2). */
export function FilePreview({ path }: { path: string }) {
  const version = useEditorStore((s) => s.filesVersion);
  const kind = fileKind(path);
  const isEps = path.toLowerCase().endsWith('.eps');

  if (kind === 'image' && isEps) {
    return (
      <Notice title="EPS can't be previewed" icon={<ImageOff />}>
        Browsers can't display EPS files. LaTeX uses {path} directly when compiling.
      </Notice>
    );
  }
  if (kind === 'image') return <ImagePreview path={path} version={version} />;
  if (kind === 'pdf') return <PdfPreview path={path} version={version} />;
  return (
    <Notice title="Can't open this file here" icon={<FileQuestion />}>
      {path} is not a text file, an image or a PDF.
    </Notice>
  );
}
