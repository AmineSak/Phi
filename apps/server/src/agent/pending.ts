// Proposals waiting for the user's review, keyed by tool call id (SPEC 2.2, 3.3, 3.8).

import type { Proposal, ReviewDecisionRequest, ReviewOutcome } from '@phi/shared';

/** No decision after 10 minutes cancels a proposal (SPEC 3.8). */
export const REVIEW_TIMEOUT_MS = 10 * 60_000;

/** How a review ended, as the tool sees it. `failed`: an accepted file operation could not be applied. */
export type Decision =
  ReviewDecisionRequest | { decision: 'cancelled' } | { decision: 'failed'; error: string };

/** A taken review: the caller decided it and must settle it exactly once. */
export interface TakenReview {
  proposal: Proposal;
  settle: (decision: Decision) => void;
}

export interface PendingOptions {
  timeoutMs?: number;
  /** Called once per review when it ends, to tell every tab (review_resolved). */
  onSettled: (toolCallId: string, outcome: ReviewOutcome) => void;
}

const outcomeOf = (decision: Decision): ReviewOutcome =>
  decision.decision === 'failed' ? 'accepted' : decision.decision;

export type Pending = ReturnType<typeof createPending>;

export function createPending({ timeoutMs = REVIEW_TIMEOUT_MS, onSettled }: PendingOptions) {
  const entries = new Map<string, TakenReview>();

  return {
    /**
     * Registers `proposal` and resolves with the user's decision, or `cancelled` after the
     * timeout. Rejects with the signal's reason when the run is aborted.
     */
    wait(proposal: Proposal, signal?: AbortSignal): Promise<Decision> {
      signal?.throwIfAborted();
      if (entries.has(proposal.id)) throw new Error(`Proposal ${proposal.id} is already pending`);
      return new Promise<Decision>((resolve, reject) => {
        let done = false;
        // Whatever ends the review first (decision, timeout, abort) wins; the rest are no-ops.
        const finish = (outcome: ReviewOutcome, end: () => void) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          entries.delete(proposal.id);
          onSettled(proposal.id, outcome);
          end();
        };
        const onAbort = () => finish('aborted', () => reject(signal?.reason));
        const timer = setTimeout(
          () => finish('cancelled', () => resolve({ decision: 'cancelled' })),
          timeoutMs,
        );
        signal?.addEventListener('abort', onAbort, { once: true });
        entries.set(proposal.id, {
          proposal,
          settle: (decision) => finish(outcomeOf(decision), () => resolve(decision)),
        });
      });
    },

    /**
     * Claims a pending review so no other decision can win (SPEC 3.7): the caller settles it.
     * Undefined when it was already decided, cancelled, or never existed.
     */
    take(toolCallId: string): TakenReview | undefined {
      const entry = entries.get(toolCallId);
      if (!entry) return undefined;
      // Removed now, so a second decision finds nothing.
      entries.delete(toolCallId);
      return entry;
    },

    /** The proposal waiting under `toolCallId`, without claiming it. */
    peek(toolCallId: string): Proposal | undefined {
      return entries.get(toolCallId)?.proposal;
    },
  };
}
