import { useState } from 'react';
import {
  FilePen,
  FileText,
  FolderPen,
  FolderTree,
  Hammer,
  Search,
  Undo2,
  Wrench,
} from 'lucide-react';
import {
  COMPILE,
  LIST_FILES,
  PROPOSE_EDIT,
  PROPOSE_FILE_OP,
  READ_FILE,
  SEARCH,
  type ReviewToolDetails,
} from '@phi/shared';

import { Button } from '@/components/ui/button';
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockHeader,
  CodeBlockTitle,
} from '@/components/ui/code-block';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace';

import type { ToolCall } from '../../agent/reducer.ts';
import { revertable, revertProposal } from '../../agent/reviews.ts';
import { getDoc } from '../../editor/views.ts';
import { useAgentStore } from '../../store/agent-store.ts';
import { useEditorStore } from '../../store/editor-store.ts';
import { useReviewStore } from '../../store/review-store.ts';

const ICONS: Record<string, typeof Wrench> = {
  [LIST_FILES]: FolderTree,
  [READ_FILE]: FileText,
  [SEARCH]: Search,
  [COMPILE]: Hammer,
  [PROPOSE_EDIT]: FilePen,
  [PROPOSE_FILE_OP]: FolderPen,
};

const isReview = (tool: ToolCall) => tool.name === PROPOSE_EDIT || tool.name === PROPOSE_FILE_OP;

/** The review result of a finished proposal tool, if it has one. */
function reviewDetails(tool: ToolCall): ReviewToolDetails | null {
  const details = tool.details as ReviewToolDetails | undefined;
  return isReview(tool) && details?.proposal && details.outcome ? details : null;
}

const OUTCOMES: Record<ReviewToolDetails['outcome'], string> = {
  accepted: 'Applied',
  rejected: 'Rejected',
  stale: 'Not applied: the file changed',
  cancelled: 'Cancelled: no decision in 10 minutes',
  aborted: 'Stopped',
};

function outcomeText(details: ReviewToolDetails, reverted: boolean): string {
  if (reverted) return 'Reverted';
  const { proposal, outcome, hunks } = details;
  if (outcome === 'accepted' && proposal.type === 'edit' && hunks) {
    const applied = hunks.filter((h) => h.accepted).length;
    if (applied === 0) return 'Rejected';
    if (applied < proposal.hunks.length)
      return `Applied ${applied} of ${proposal.hunks.length} hunks`;
  }
  return OUTCOMES[outcome];
}

/** "Read file chapters/intro.tex", "Search "\label"": the label plus its key argument. */
function title(tool: ToolCall): string {
  const args = (tool.args ?? {}) as Record<string, unknown>;
  const subject =
    typeof args.path === 'string'
      ? args.path
      : typeof args.query === 'string'
        ? `"${args.query}"`
        : '';
  return subject ? `${tool.label} ${subject}` : tool.label;
}

function description(tool: ToolCall, reverted: boolean): string {
  if (tool.status === 'running')
    return isReview(tool) ? 'Waiting for your review' : (tool.progress ?? 'Running…');
  const review = reviewDetails(tool);
  return review ? outcomeText(review, reverted) : (tool.summary ?? '');
}

/** SPEC 3.6: offered while the applied regions still hold exactly the applied text. */
function RevertAction({ details }: { details: ReviewToolDetails }) {
  // Re-checked whenever any loaded file's text changes.
  useEditorStore((s) => s.docVersion);
  const [busy, setBusy] = useState(false);
  const current = getDoc(details.proposal.path);
  // A file not loaded in the editor is checked when Revert is clicked.
  if (current !== undefined && !revertable(details, current)) return null;
  return (
    <Button
      variant="ghost"
      size="xs"
      className="ml-6 self-start text-muted-foreground"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await revertProposal(details);
        setBusy(false);
      }}
    >
      <Undo2 />
      Revert
    </Button>
  );
}

const STATUS = { running: 'running', error: 'error', done: undefined } as const;

/** One tool call: label, short result, and the arguments and result when expanded. */
export function ToolCallCard({ id }: { id: string }) {
  const tool = useAgentStore((s) => s.chat.tools[id]);
  const reverted = useReviewStore((s) => !!s.reverted[id]);
  if (!tool) return null;
  const Icon = ICONS[tool.name] ?? Wrench;
  const review = reviewDetails(tool);
  const diff = review?.proposal.type === 'edit' ? review.proposal.diff : null;
  const args = JSON.stringify(tool.args ?? {}, null, 2);
  const canRevert = review?.proposal.type === 'edit' && review.outcome === 'accepted' && !reverted;

  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine status={STATUS[tool.status]}>
            <TraceIcon>
              <Icon />
            </TraceIcon>
            <TraceTitle>{title(tool)}</TraceTitle>
            <TraceDescription className="min-w-0 shrink truncate text-muted-foreground">
              {description(tool, reverted)}
            </TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="flex flex-col gap-2">
          {review && <p className="text-sm text-muted-foreground">{review.proposal.rationale}</p>}
          <CodeBlock size="sm">
            <CodeBlockHeader>
              <CodeBlockTitle>{diff ? 'Diff' : 'Arguments'}</CodeBlockTitle>
            </CodeBlockHeader>
            <CodeBlockContent wrap className="max-h-40">
              {diff ?? args}
            </CodeBlockContent>
          </CodeBlock>
          {tool.summary && (
            <CodeBlock size="sm" variant={tool.status === 'error' ? 'destructive' : undefined}>
              <CodeBlockHeader>
                <CodeBlockTitle>{tool.status === 'error' ? 'Error' : 'Result'}</CodeBlockTitle>
              </CodeBlockHeader>
              <CodeBlockContent wrap className="max-h-40">
                {tool.summary}
              </CodeBlockContent>
            </CodeBlock>
          )}
        </TraceCollapsibleContent>
      </TraceCollapsible>
      {canRevert && review && <RevertAction details={review} />}
    </Trace>
  );
}
