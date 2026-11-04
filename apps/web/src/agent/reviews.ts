// Acting on proposals (SPEC 3): accept, reject, file operations and revert. No React here.

import {
  applyEdits,
  type EditProposal,
  type FileOpProposal,
  type Hunk,
  type ReviewDecisionRequest,
  type ReviewToolDetails,
} from '@phi/shared';

import { setHunkActionHandler, type HunkAction } from '../editor/proposal.ts';
import { canRevert, finishPlan, locateHunks, revertEdits } from '../editor/review-edits.ts';
import {
  followDelete,
  followRename,
  loadFileList,
  noteRevert,
  openFile,
  saveFile,
} from '../editor/session.ts';
import * as views from '../editor/views.ts';
import {
  dropProposal,
  markReverted,
  setInlineStatus,
  setReviewError,
  useReviewStore,
} from '../store/review-store.ts';
import { AlreadyDecidedError, postDecision } from './client.ts';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Posts a decision and drops the proposal from this tab's queue. False when it could not be
 * recorded; the reason is shown in the review panel.
 */
async function decide(id: string, decision: ReviewDecisionRequest) {
  try {
    const response = await postDecision(id, decision);
    dropProposal(id);
    setReviewError(null);
    return response;
  } catch (err) {
    // Another tab was first: this one just updates (SPEC 3.7).
    if (err instanceof AlreadyDecidedError) dropProposal(id);
    else setReviewError(message(err));
    return null;
  }
}

/** Replacements for located hunks, as CodeMirror changes. */
const changesOf = (hunks: Hunk[]) =>
  hunks.map((h) => ({ from: h.start, to: h.end, insert: h.newText }));

/** The changes that undo `changes` (sorted, non-overlapping) once they are applied to `before`. */
function inverseOf(before: string, changes: { from: number; to: number; insert: string }[]) {
  let shift = 0;
  return [...changes]
    .sort((a, b) => a.from - b.from)
    .map((c) => {
      const from = c.from + shift;
      shift += c.insert.length - (c.to - c.from);
      return { from, to: from + c.insert.length, insert: before.slice(c.from, c.to) };
    });
}

const editProposal = (id: string) =>
  useReviewStore.getState().queue.find((p): p is EditProposal => p.id === id && p.type === 'edit');

/** Proposals being finished right now, so a double click can't finish one twice. */
const finishing = new Set<string>();

/**
 * Shows an edit proposal inside its file (SPEC 3.1): the file opens, and each hunk appears
 * where its text is in the buffer now.
 */
export async function presentProposal(proposal: EditProposal): Promise<void> {
  await openFile(proposal.path);
  if (views.inlineProposalOf(proposal.path)?.id === proposal.id) return;
  const current = views.getDoc(proposal.path) ?? '';
  views.showInlineProposal(proposal.path, locateHunks(current, proposal));
}

/**
 * Applies the proposal once every hunk is decided (SPEC 3.2-3.5): the accepted hunks in one
 * undo step, saved at once, then the decision is posted. If the server doesn't take the
 * decision (another tab was first, or an error), the change is taken back out.
 */
async function finish(proposal: EditProposal, reason?: string): Promise<void> {
  const { path, id } = proposal;
  const inline = views.inlineProposalOf(path);
  if (!inline || inline.id !== id || finishing.has(id)) return;
  const current = views.getDoc(path) ?? '';
  const plan = finishPlan(proposal, inline, current, reason);
  if (plan.kind === 'pending') return;

  finishing.add(id);
  try {
    if (plan.kind === 'decide') {
      views.clearInlineProposal(path);
      if (!(await decide(id, plan.decision)) && editProposal(id)) await presentProposal(proposal);
      return;
    }
    views.applyInlineProposal(path, plan.changes);
    await saveFile(path);
    if (await decide(id, plan.decision)) return;
    // Not recorded: undo it, and show the proposal again if it is still waiting.
    views.applyInlineProposal(path, inverseOf(current, plan.changes));
    await saveFile(path);
    if (editProposal(id)) await presentProposal(proposal);
  } finally {
    finishing.delete(id);
  }
}

/** A click on a hunk's Accept, Reject, Undo or Edit (proposal.ts). */
export async function hunkAction(id: string, index: number, action: HunkAction): Promise<void> {
  const proposal = editProposal(id);
  if (!proposal || finishing.has(id) || views.inlineProposalOf(proposal.path)?.id !== id) return;
  const { path } = proposal;
  if (action.kind === 'edit') {
    views.updateInlineHunk(path, index, { newText: action.text });
    return;
  }
  const status =
    action.kind === 'accept' ? 'accepted' : action.kind === 'reject' ? 'rejected' : 'pending';
  views.updateInlineHunk(path, index, { status });
  await finish(proposal);
}

/** Accepts every hunk still pending, then finishes the proposal. */
export async function acceptAll(id: string): Promise<void> {
  const proposal = editProposal(id);
  if (!proposal || finishing.has(id)) return;
  if (views.inlineProposalOf(proposal.path)?.id !== id) await presentProposal(proposal);
  for (const hunk of views.inlineProposalOf(proposal.path)?.hunks ?? []) {
    if (hunk.status === 'pending')
      views.updateInlineHunk(proposal.path, hunk.index, { status: 'accepted' });
  }
  await finish(proposal);
}

/** Rejects the whole proposal, with an optional reason for the agent. */
export async function rejectAll(id: string, reason?: string): Promise<void> {
  const proposal = editProposal(id);
  if (!proposal || finishing.has(id)) return;
  if (views.inlineProposalOf(proposal.path)?.id !== id) {
    await rejectProposal(proposal, reason);
    return;
  }
  for (const hunk of views.inlineProposalOf(proposal.path)?.hunks ?? []) {
    views.updateInlineHunk(proposal.path, hunk.index, { status: 'rejected' });
  }
  await finish(proposal, reason);
}

/**
 * Keeps the first proposal of the queue shown in its file (SPEC 3.3), and removes it from the
 * file when its review ends some other way (another tab, the 10-minute timeout, Stop).
 */
export function startReviewPresenter(): () => void {
  setHunkActionHandler((id, index, action) => void hunkAction(id, index, action));
  let shown: EditProposal | null = null;
  const sync = () => {
    const { queue } = useReviewStore.getState();
    if (shown && !queue.some((p) => p.id === shown!.id)) {
      if (views.inlineProposalOf(shown.path)?.id === shown.id)
        views.clearInlineProposal(shown.path);
      shown = null;
    }
    const head = queue[0];
    if (head?.type === 'edit' && head.id !== shown?.id) {
      shown = head;
      void presentProposal(head);
    }
  };
  const offStore = useReviewStore.subscribe(sync);
  const offViews = views.onProposalChange((path) => {
    const inline = views.inlineProposalOf(path);
    setInlineStatus(
      inline
        ? {
            id: inline.id,
            path,
            total: inline.hunks.length,
            pending: inline.hunks.filter((h) => h.status === 'pending').length,
            stale: inline.hunks.filter((h) => h.stale && h.status !== 'rejected').length,
          }
        : null,
    );
  });
  sync();
  return () => {
    offStore();
    offViews();
  };
}

export async function rejectProposal(proposal: { id: string }, reason?: string): Promise<void> {
  await decide(
    proposal.id,
    reason?.trim() ? { decision: 'rejected', reason } : { decision: 'rejected' },
  );
}

/** Accepts a file operation; the server applies it, then tabs and buffers follow. */
export async function acceptFileOp(proposal: FileOpProposal): Promise<void> {
  // The trash and the renamed file should hold the latest text.
  if (proposal.op !== 'create' && views.isDirty(proposal.path)) await saveFile(proposal.path);
  const response = await decide(proposal.id, { decision: 'accepted' });
  if (!response) return;
  if (proposal.op === 'create') {
    await loadFileList();
    if (response.created) await openFile(response.created.path);
  } else if (proposal.op === 'rename' && proposal.newPath) {
    await followRename(proposal.path, proposal.newPath);
  } else if (proposal.op === 'delete') {
    await followDelete(proposal.path);
  }
}

/** Whether an applied edit can be reverted: its regions still hold the applied text (SPEC 3.6). */
export function revertable(details: ReviewToolDetails, current: string): boolean {
  if (details.proposal.type !== 'edit' || details.outcome !== 'accepted' || !details.hunks) {
    return false;
  }
  return canRevert(current, revertEdits(details.proposal, details.hunks));
}

/**
 * Reverts an applied edit as one undo step, saves, and tells the agent in its next request.
 * Returns false (with the reason in the review panel) when the regions changed since.
 */
export async function revertProposal(details: ReviewToolDetails): Promise<boolean> {
  const { proposal, hunks: decisions } = details;
  if (proposal.type !== 'edit' || !decisions) return false;
  await views.loadFile(proposal.path);
  const current = views.getDoc(proposal.path) ?? '';
  const edits = revertEdits(proposal, decisions);
  if (!canRevert(current, edits)) {
    setReviewError(`Can't revert: the changed text in ${proposal.path} was edited since.`);
    return false;
  }
  let hunks: Hunk[];
  try {
    ({ hunks } = applyEdits(current, edits));
  } catch (err) {
    setReviewError(`Can't revert: ${message(err)}`);
    return false;
  }
  await views.applyChanges(proposal.path, changesOf(hunks));
  await saveFile(proposal.path);
  noteRevert(proposal.id);
  markReverted(proposal.id);
  setReviewError(null);
  return true;
}
