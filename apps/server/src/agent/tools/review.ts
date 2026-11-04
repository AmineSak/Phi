import type { AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';
import type { Proposal } from '@phi/shared';

import type { Decision, Pending } from '../pending.ts';
import { textContent } from './types.ts';

/** `details` of the tool update that asks for a review; wire.ts turns it into awaiting_user. */
export interface ReviewRequestDetails {
  kind: 'review_request';
  proposal: Proposal;
}

/**
 * Shows `proposal` to the user and waits for their decision. The proposal is registered
 * before the update goes out, so a decision can never arrive first.
 */
export function requestReview(
  proposal: Proposal,
  pending: Pending,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback | undefined,
): Promise<Decision> {
  const decided = pending.wait(proposal, signal);
  onUpdate?.({
    content: textContent('Waiting for the user to review the proposal.'),
    details: { kind: 'review_request', proposal } satisfies ReviewRequestDetails,
  });
  return decided;
}

export const CANCELLED_TEXT =
  'The user made no decision within 10 minutes, so the proposal was cancelled and nothing was ' +
  'applied. Mention it in your reply instead of proposing it again unasked.';

/** "Reason: …", or a note that none was given. */
export const rejectReason = (reason?: string) =>
  reason?.trim()
    ? `Their reason: ${reason.trim()}`
    : 'They gave no reason; ask what they would prefer if it is not clear.';

/** Rationale shown to the user: one line. */
export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
