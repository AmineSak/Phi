import { FileSearch, FileText, MessageSquareQuote, TriangleAlert, X } from 'lucide-react';
import { fileKind } from '@phi/shared';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { askAboutSelection } from '../../agent/shortcuts.ts';
import {
  closeFile,
  currentSelection,
  openFile,
  resolveConflict,
  showInPdf,
} from '../../editor/session.ts';
import { useEditorStore } from '../../store/editor-store.ts';
import { ProposalBar } from '../Review/ProposalBar.tsx';
import { FilePreview } from './FilePreview.tsx';
import { useCodeMirror } from './useCodeMirror.ts';

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** SPEC 5.8: quotes the selection into the chat composer. */
function AskAboutSelection() {
  const hasSelection = useEditorStore((s) => s.hasSelection);
  if (!hasSelection) return null;
  return (
    <Button
      variant="ghost"
      size="xs"
      className="mr-2 shrink-0 text-muted-foreground"
      // Keep the editor's selection: don't take focus on mousedown.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const selection = currentSelection();
        if (selection) askAboutSelection(selection);
      }}
    >
      <MessageSquareQuote />
      Ask about selection
    </Button>
  );
}

function OpenTabs() {
  const openPaths = useEditorStore((s) => s.openPaths);
  const activePath = useEditorStore((s) => s.activePath);
  const saveStatus = useEditorStore((s) => s.saveStatus);
  if (openPaths.length === 0) return null;

  return (
    <div className="flex h-9 shrink-0 items-center border-b">
      <Tabs
        value={activePath}
        onValueChange={(path) => void openFile(String(path))}
        className="min-w-0 flex-1"
      >
        <TabsList variant="line" className="h-9 w-full justify-start gap-0 rounded-none px-2">
          {openPaths.map((path) => {
            const status = saveStatus[path];
            const unsaved = status === 'unsaved' || status === 'saving' || status === 'conflict';
            return (
              <div key={path} className="flex items-center">
                <TabsTrigger value={path} title={path} className="flex-none px-2.5">
                  {fileName(path)}
                  {unsaved && (
                    <span
                      className="size-1.5 rounded-full bg-muted-foreground"
                      aria-label="unsaved"
                    />
                  )}
                </TabsTrigger>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Close ${fileName(path)}`}
                  className="text-muted-foreground"
                  onClick={() => void closeFile(path)}
                >
                  <X />
                </Button>
              </div>
            );
          })}
        </TabsList>
      </Tabs>
      <AskAboutSelection />
    </div>
  );
}

function ConflictBanner() {
  const conflict = useEditorStore((s) => s.conflict);
  const saveError = useEditorStore((s) => s.saveError);

  if (conflict) {
    return (
      <Alert className="rounded-none border-x-0 border-t-0">
        <TriangleAlert className="text-warning" />
        <AlertTitle>{fileName(conflict.path)} changed on disk</AlertTitle>
        <AlertDescription>
          <p>
            {conflict.mtimeMs === null
              ? 'It was deleted outside the editor. Overwrite to write your version back.'
              : 'Another program changed it. Autosave is paused until you choose.'}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {conflict.mtimeMs !== null && (
              <Button size="sm" variant="outline" onClick={() => void resolveConflict('reload')}>
                Reload from disk
              </Button>
            )}
            <Button
              size="sm"
              variant="destructive"
              onClick={() => void resolveConflict('overwrite')}
            >
              Overwrite with mine
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    );
  }
  if (saveError) {
    return (
      <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
        <TriangleAlert />
        <AlertTitle>Not saved</AlertTitle>
        <AlertDescription>{saveError}</AlertDescription>
      </Alert>
    );
  }
  return null;
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

/** Right-click in the editor: "Show in PDF" (SPEC 6.4) and "Ask about selection" (SPEC 5.8). */
function EditorMenu({ children }: { children: React.ReactNode }) {
  const hasSelection = useEditorStore((s) => s.hasSelection);
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="absolute inset-0" />}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onClick={() => void showInPdf()}>
          <FileSearch />
          Show in PDF
          <ContextMenuShortcut>{isMac ? '⌘⌥J' : 'Ctrl+Alt+J'}</ContextMenuShortcut>
        </ContextMenuItem>
        {hasSelection && (
          <ContextMenuItem
            onClick={() => {
              const selection = currentSelection();
              if (selection) askAboutSelection(selection);
            }}
          >
            <MessageSquareQuote />
            Ask about selection
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function EditorPane() {
  const activePath = useEditorStore((s) => s.activePath);
  const host = useCodeMirror(activePath);

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <OpenTabs />
      <ProposalBar />
      <ConflictBanner />
      <div className="relative min-h-0 flex-1">
        <EditorMenu>
          <div ref={host} className="h-full" />
        </EditorMenu>
        {activePath && fileKind(activePath) !== 'text' && (
          <div className="absolute inset-0 bg-card">
            <FilePreview path={activePath} />
          </div>
        )}
        {!activePath && (
          <Empty className="absolute inset-0 bg-card">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileText />
              </EmptyMedia>
              <EmptyTitle>No file open</EmptyTitle>
              <EmptyDescription>Pick a file in the project tree to start editing.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </div>
  );
}
