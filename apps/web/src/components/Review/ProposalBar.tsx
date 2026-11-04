import { useState } from 'react';
import { Check, FilePen, TriangleAlert, X } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

import { acceptAll, presentProposal, rejectAll } from '../../agent/reviews.ts';
import { useEditorStore } from '../../store/editor-store.ts';
import { useReviewStore } from '../../store/review-store.ts';
import { FileOpDialog } from './FileOpDialog.tsx';

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * The first pending proposal (SPEC 3.3): an edit is reviewed inside its file, this bar holds
 * its rationale and Accept all / Reject all; a file operation opens a dialog.
 */
export function ProposalBar() {
  const queue = useReviewStore((s) => s.queue);
  const inline = useReviewStore((s) => s.inline);
  const error = useReviewStore((s) => s.error);
  const activePath = useEditorStore((s) => s.activePath);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null);
  const head = queue[0];
  if (!head) return null;
  if (head.type === 'file_op') {
    return (
      <FileOpDialog key={head.id} proposal={head} position={1} total={queue.length} error={error} />
    );
  }

  const shown = inline?.id === head.id && activePath === head.path;
  const reviewed = inline?.id === head.id ? inline.total - inline.pending : 0;
  const total = head.hunks.length;
  const run = async (which: 'accept' | 'reject') => {
    setBusy(which);
    if (which === 'accept') await acceptAll(head.id);
    else await rejectAll(head.id, reason);
    setBusy(null);
    setReason('');
  };

  return (
    <section
      aria-label="Proposed edit"
      className="flex shrink-0 flex-col border-b bg-[color-mix(in_oklch,var(--diff-added)_7%,var(--card))]"
    >
      <div className="flex min-w-0 items-center gap-2 px-3 pt-1.5">
        <FilePen className="size-4 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 truncate text-sm">
          <span className="font-semibold">Suggested edit</span>{' '}
          <span className="font-mono text-xs text-muted-foreground">{fileName(head.path)}</span>
        </p>
        {queue.length > 1 && (
          <Badge variant="outline" className="shrink-0 tabular-nums">
            1 of {queue.length}
          </Badge>
        )}
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums" aria-live="polite">
          {reviewed} of {total} {total === 1 ? 'change' : 'changes'} reviewed
        </span>
        <Button
          size="xs"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void run('reject')}
        >
          {busy === 'reject' ? <Spinner /> : <X />}
          Reject all
        </Button>
        <Button size="xs" disabled={busy !== null} onClick={() => void run('accept')}>
          {busy === 'accept' ? <Spinner /> : <Check />}
          Accept all
        </Button>
      </div>
      <div className="flex min-w-0 items-center gap-2 px-3 pt-1 pb-1.5 pl-9">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={head.rationale}>
          {head.rationale}
        </p>
        {!shown && (
          <Button size="xs" variant="outline" onClick={() => void presentProposal(head)}>
            Show in {fileName(head.path)}
          </Button>
        )}
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason, if you reject"
          title="Sent to the agent when you reject"
          aria-label="Reason for rejecting"
          className="h-6 w-40 shrink-0 text-xs md:text-xs"
        />
      </div>
      {inline?.id === head.id && inline.stale > 0 && (
        <p className="px-3 pb-1.5 text-xs text-warning">
          You changed the text of {inline.stale === 1 ? 'one change' : `${inline.stale} changes`}{' '}
          since: it can only be rejected, or the agent gets your current text to try again.
        </p>
      )}
      {error && (
        <Alert variant="destructive" className="rounded-none border-x-0 border-b-0">
          <TriangleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}
