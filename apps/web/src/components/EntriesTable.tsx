import { useState } from 'react';
import { FileWarning, ScrollText, Sparkles } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

import { fixWithAi } from '../agent/shortcuts.ts';
import type { Entry } from '../editor/entries.ts';
import { selectEntry } from '../editor/session.ts';
import { countEntries, useCompileStore } from '../store/compile-store.ts';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function location(entry: Entry): string {
  if (entry.file && entry.line !== null) return `${entry.file}:${entry.line}`;
  if (entry.file) return entry.file;
  return entry.line !== null ? `line ${entry.line}` : 'see log';
}

function EntryRow({ entry }: { entry: Entry }) {
  const active = useCompileStore((s) => s.activeEntryId === entry.id);
  const visited = useCompileStore((s) => !!s.visited[entry.id]);
  const select = () => void selectEntry(entry.id);

  return (
    <TableRow
      tabIndex={0}
      aria-selected={active}
      data-state={active ? 'selected' : undefined}
      onClick={select}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select();
        }
      }}
      className="cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      <TableCell
        className={cn(
          'w-14 font-semibold',
          entry.kind === 'error' ? 'text-destructive' : 'text-warning',
        )}
      >
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-sm px-1 ring-1 ring-transparent',
            active && 'ring-current',
          )}
        >
          {entry.id}
          {entry.isNew && !visited && (
            <span className="size-1.5 rounded-full bg-current" aria-label="new in this build" />
          )}
        </span>
      </TableCell>
      <TableCell className="w-56 font-mono text-xs text-muted-foreground">
        {location(entry)}
      </TableCell>
      <TableCell className="whitespace-normal">{entry.message}</TableCell>
      <TableCell className="w-28 text-right">
        {entry.kind === 'error' && (
          <Button
            variant="outline"
            size="xs"
            title="Ask the agent to fix this error"
            onClick={(e) => {
              e.stopPropagation(); // the row itself opens the error's line
              void fixWithAi(entry);
            }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Sparkles />
            Fix with AI
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

/** A single muted row in place of entries: the table keeps its head and rule in every state. */
function NoteRow({ children }: { children: React.ReactNode }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={4} className="whitespace-normal text-muted-foreground">
        {children}
      </TableCell>
    </TableRow>
  );
}

export function EntriesTable() {
  const { status, build, entries, logTail, error } = useCompileStore();
  const [showLog, setShowLog] = useState(false);
  const { errors, warnings } = countEntries(entries);
  const unlocated = entries.some((e) => e.line === null || !e.file);
  const logOpen = showLog || (status === 'failed' && errors === 0);

  return (
    <section aria-label="Entries" className="flex h-full min-h-0 flex-col bg-card">
      <header className="flex h-9 shrink-0 items-center gap-3 border-b px-3">
        <h2 className="text-sm font-semibold">Entries</h2>
        {build > 0 && (
          <p className="truncate text-xs text-muted-foreground">
            Build {build} ·{' '}
            <span className={cn(errors > 0 && 'font-semibold text-destructive')}>
              {plural(errors, 'error')}
            </span>{' '}
            ·{' '}
            <span className={cn(warnings > 0 && 'font-semibold text-warning')}>
              {plural(warnings, 'warning')}
            </span>
          </p>
        )}
        {build > 0 && (
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto text-muted-foreground"
            aria-pressed={logOpen}
            onClick={() => setShowLog(!showLog)}
          >
            <ScrollText />
            {logOpen ? 'Hide log' : unlocated ? 'Log (some entries have no line)' : 'Log'}
          </Button>
        )}
      </header>
      <ScrollArea className="min-h-0 flex-1">
        {error && (
          <Alert variant="destructive" className="m-3 w-auto">
            <FileWarning />
            <AlertTitle>The compile did not run</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Table>
          <TableHeader>
            <TableRow className="border-foreground hover:bg-transparent">
              <TableHead className="w-14">No.</TableHead>
              <TableHead className="w-56">Location</TableHead>
              <TableHead>Message</TableHead>
              <TableHead className="w-28">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {build === 0 ? (
              <NoteRow>
                Not compiled yet. Compile (⌘S / Ctrl+S) to number the errors and warnings and link
                them to their lines.
              </NoteRow>
            ) : entries.length === 0 ? (
              <NoteRow>No entries in Build {build}: no errors or warnings.</NoteRow>
            ) : (
              entries.map((entry) => <EntryRow key={entry.id} entry={entry} />)
            )}
          </TableBody>
        </Table>
        {logOpen && (
          <pre className="border-t px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {logTail || 'The log is empty.'}
          </pre>
        )}
      </ScrollArea>
    </section>
  );
}
