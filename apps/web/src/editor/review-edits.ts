// Pure helpers for reviewing edit proposals: preview, stale check (SPEC 3.4), revert (SPEC 3.6).

import {
  applyEdits,
  lineAt,
  type EditProposal,
  type HunkDecision,
  type ReviewDecisionRequest,
  type TextEdit,
} from '@phi/shared';

import type { InlineHunk, InlineProposal } from './proposal.ts';

/** Characters of unchanged text kept around a reverted hunk, so its region is found exactly. */
const REVERT_CONTEXT = 60;
/** Lines of current text sent around a hunk that no longer applies. */
const STALE_CONTEXT_LINES = 3;

/** The text a hunk will have: the user's edit of it, else the proposed text. */
const finalOf = (proposal: EditProposal, d: HunkDecision) =>
  d.finalText ?? proposal.hunks[d.index]!.newText;

/** The accepted hunks as edits: original text to final text, in hunk order. */
export function acceptedEdits(proposal: EditProposal, decisions: HunkDecision[]) {
  return decisions
    .filter((d) => d.accepted)
    .sort((a, b) => a.index - b.index)
    .map((d) => ({
      index: d.index,
      edit: { oldText: proposal.hunks[d.index]!.oldText, newText: finalOf(proposal, d) },
    }));
}

/** The current text on and around the lines the hunk had in baseText. */
export function regionAround(current: string, proposal: EditProposal, index: number): string {
  const hunk = proposal.hunks[index]!;
  const first = lineAt(proposal.baseText, hunk.start);
  const last = lineAt(proposal.baseText, hunk.end);
  const lines = current.split('\n');
  const from = Math.max(0, first - 1 - STALE_CONTEXT_LINES);
  const to = Math.min(lines.length, last + STALE_CONTEXT_LINES);
  return lines.slice(from, to).join('\n');
}

/**
 * Edits that undo an applied proposal: each applied region (with up to 60 characters of the
 * unchanged text around it, from baseText) back to its original text.
 */
export function revertEdits(proposal: EditProposal, decisions: HunkDecision[]): TextEdit[] {
  const { hunks, baseText } = proposal;
  return acceptedEdits(proposal, decisions).map(({ index, edit }) => {
    const hunk = hunks[index]!;
    // Neighbouring hunks share the unchanged text between them at its midpoint, so the
    // contexts of two reverts never overlap.
    const prev = hunks[index - 1];
    const next = hunks[index + 1];
    const from = prev ? Math.ceil((prev.end + hunk.start) / 2) : 0;
    const to = next ? Math.floor((hunk.end + next.start) / 2) : baseText.length;
    const before = baseText.slice(Math.max(from, hunk.start - REVERT_CONTEXT), hunk.start);
    const after = baseText.slice(hunk.end, Math.min(to, hunk.end + REVERT_CONTEXT));
    return { oldText: before + edit.newText + after, newText: before + edit.oldText + after };
  });
}

/**
 * Whether the applied regions still hold exactly the applied text: each revert edit's
 * oldText occurs exactly once in `current` (no fuzzy matching).
 */
export function canRevert(current: string, edits: TextEdit[]): boolean {
  if (edits.length === 0) return false;
  const exact = edits.every(({ oldText }) => {
    if (!oldText) return false;
    const at = current.indexOf(oldText);
    return at !== -1 && current.indexOf(oldText, at + 1) === -1;
  });
  if (!exact) return false;
  try {
    applyEdits(current, edits); // and they must not overlap
    return true;
  } catch {
    return false;
  }
}

/**
 * Where each hunk's original text is in `current` (the editor's buffer, which may differ from
 * the proposal's baseText). A hunk whose text can't be found exactly once starts out stale.
 */
export function locateHunks(current: string, proposal: EditProposal): InlineProposal {
  const hunks: InlineHunk[] = proposal.hunks.map((hunk, index) => {
    const base = { index, newText: hunk.newText, status: 'pending' as const };
    try {
      const [found] = applyEdits(current, [{ oldText: hunk.oldText, newText: hunk.newText }]).hunks;
      return { ...base, from: found!.start, to: found!.end, stale: false };
    } catch {
      return { ...base, from: null, to: null, stale: true };
    }
  });
  return { id: proposal.id, hunks };
}

/** What to do once no hunk is pending. */
export type FinishPlan =
  | { kind: 'pending' }
  | {
      kind: 'apply';
      changes: { from: number; to: number; insert: string }[];
      decision: ReviewDecisionRequest;
    }
  | { kind: 'decide'; decision: ReviewDecisionRequest };

/**
 * The outcome of a proposal from the user's per-hunk choices (SPEC 3.2-3.4): nothing while a
 * hunk is undecided; "rejected" if none was accepted; "stale" if an accepted hunk's text was
 * changed since (nothing is applied); else the accepted hunks' changes and the decisions.
 */
export function finishPlan(
  proposal: EditProposal,
  inline: InlineProposal,
  current: string,
  reason?: string,
): FinishPlan {
  if (inline.hunks.some((h) => h.status === 'pending')) return { kind: 'pending' };
  const accepted = inline.hunks.filter((h) => h.status === 'accepted');
  if (accepted.length === 0) {
    return {
      kind: 'decide',
      decision: reason?.trim()
        ? { decision: 'rejected', reason: reason.trim() }
        : { decision: 'rejected' },
    };
  }
  const stale = accepted.filter((h) => h.stale || h.from === null || h.to === null);
  if (stale.length > 0) {
    return {
      kind: 'decide',
      decision: {
        decision: 'stale',
        currentRegions: stale.map((h) => ({
          index: h.index,
          text: regionAround(current, proposal, h.index),
        })),
      },
    };
  }
  const hunks: HunkDecision[] = inline.hunks.map((h) => ({
    index: h.index,
    accepted: h.status === 'accepted',
    ...(h.status === 'accepted' && h.newText !== proposal.hunks[h.index]!.newText
      ? { finalText: h.newText }
      : {}),
  }));
  return {
    kind: 'apply',
    changes: accepted.map((h) => ({ from: h.from!, to: h.to!, insert: h.newText })),
    decision: { decision: 'accepted', hunks },
  };
}
