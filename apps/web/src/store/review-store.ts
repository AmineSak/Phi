import type { Proposal, WireEvent } from '@phi/shared';
import { create } from 'zustand';

interface ReviewStore {
  /** Proposals waiting for a decision, in the order they were made (SPEC 3.3). */
  queue: Proposal[];
  /** Tool calls whose applied edit this tab reverted (SPEC 3.6). */
  reverted: Record<string, true>;
  /** The last problem deciding or reverting, shown in the proposal bar. */
  error: string | null;
  /** The proposal shown inside a file and how far its review is (SPEC 3.2). */
  inline: InlineStatus | null;
}

export interface InlineStatus {
  id: string;
  path: string;
  total: number;
  pending: number;
  /** Hunks whose text the user changed since; they can only be rejected. */
  stale: number;
}

export const useReviewStore = create<ReviewStore>(() => ({
  queue: [],
  reverted: {},
  error: null,
  inline: null,
}));

export function setInlineStatus(inline: InlineStatus | null): void {
  useReviewStore.setState({ inline });
}

/** Feeds wire events: awaiting_user queues a proposal, review_resolved drops it (SPEC 3.7). */
export function dispatchReview(event: WireEvent): void {
  if (event.type === 'awaiting_user') {
    useReviewStore.setState((s) =>
      s.queue.some((p) => p.id === event.toolCallId) ? s : { queue: [...s.queue, event.proposal] },
    );
  } else if (event.type === 'review_resolved') {
    useReviewStore.setState((s) => ({ queue: s.queue.filter((p) => p.id !== event.toolCallId) }));
  }
}

/** A thread is shown afresh; its events replay from the start and rebuild the queue. */
export function resetReviews(): void {
  useReviewStore.setState({ queue: [], error: null });
}

/** Drops a proposal this tab decided, without waiting for review_resolved. */
export function dropProposal(id: string): void {
  useReviewStore.setState((s) => ({ queue: s.queue.filter((p) => p.id !== id) }));
}

export function markReverted(toolCallId: string): void {
  useReviewStore.setState((s) => ({ reverted: { ...s.reverted, [toolCallId]: true } }));
}

export function setReviewError(error: string | null): void {
  useReviewStore.setState({ error });
}
