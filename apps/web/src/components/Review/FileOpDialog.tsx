import { useState } from 'react';
import { ArrowRight, Check, X } from 'lucide-react';
import type { FileOpProposal } from '@phi/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockHeader,
  CodeBlockTitle,
} from '@/components/ui/code-block';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

import { acceptFileOp, rejectProposal } from '../../agent/reviews.ts';

const TITLES = { create: 'Create file', rename: 'Rename file', delete: 'Delete file' } as const;

/** A proposed create, rename or delete; the server applies it on accept. */
export function FileOpDialog({
  proposal,
  position,
  total,
  error,
}: {
  proposal: FileOpProposal;
  position: number;
  total: number;
  error: string | null;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null);
  const run = async (which: 'accept' | 'reject') => {
    setBusy(which);
    if (which === 'accept') await acceptFileOp(proposal);
    else await rejectProposal(proposal, reason);
    setBusy(null);
  };

  return (
    // Stays open until decided: a proposal can't be dismissed, only accepted or rejected.
    <Dialog open onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle>{TITLES[proposal.op]}</DialogTitle>
            <Badge variant="outline" className="ml-auto tabular-nums">
              {position} of {total}
            </Badge>
          </div>
          <DialogDescription>{proposal.rationale}</DialogDescription>
        </DialogHeader>
        <p className="flex flex-wrap items-center gap-2 font-mono text-sm">
          <span className={proposal.op === 'delete' ? 'line-through' : undefined}>
            {proposal.path}
          </span>
          {proposal.op === 'rename' && (
            <>
              <ArrowRight className="size-4 text-muted-foreground" aria-label="to" />
              <span>{proposal.newPath}</span>
            </>
          )}
        </p>
        {proposal.op === 'delete' && (
          <p className="text-sm text-muted-foreground">
            It moves to .latex-agent/trash, so you can still get it back.
          </p>
        )}
        {proposal.op === 'create' && (
          <CodeBlock size="sm">
            <CodeBlockHeader>
              <CodeBlockTitle>Content</CodeBlockTitle>
            </CodeBlockHeader>
            <CodeBlockContent className="max-h-64">
              {proposal.content || '(empty file)'}
            </CodeBlockContent>
          </CodeBlock>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason for rejecting (optional, sent to the agent)"
          aria-label="Reason for rejecting"
        />
        <DialogFooter>
          <Button variant="outline" disabled={busy !== null} onClick={() => void run('reject')}>
            {busy === 'reject' ? <Spinner /> : <X />}
            Reject
          </Button>
          <Button
            variant={proposal.op === 'delete' ? 'destructive' : 'default'}
            disabled={busy !== null}
            onClick={() => void run('accept')}
          >
            {busy === 'accept' ? <Spinner /> : <Check />}
            {proposal.op === 'delete' ? 'Move to trash' : 'Accept'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
