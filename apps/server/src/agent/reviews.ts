// Deciding a pending review (SPEC 3.2-3.4, 3.7): checks the decision against its proposal,
// applies accepted file operations, and settles the waiting tool call.

import type { FileOpProposal, ReviewDecisionRequest, ReviewDecisionResponse } from '@phi/shared';

import { createFile, remove, rename } from '../services/fs.ts';
import type { Pending } from './pending.ts';

/** The proposal was already decided (another tab was first), cancelled, or never existed. */
export class ReviewConflictError extends Error {
  override name = 'ReviewConflictError';
}

/** The decision doesn't fit the proposal (wrong hunk indexes, stale for a file operation...). */
export class InvalidDecisionError extends Error {
  override name = 'InvalidDecisionError';
}

function checkIndexes(indexes: number[], count: number, what: string): void {
  const seen = new Set<number>();
  for (const index of indexes) {
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      throw new InvalidDecisionError(`${what} index ${index} is out of range (0-${count - 1})`);
    }
    if (seen.has(index)) throw new InvalidDecisionError(`${what} index ${index} appears twice`);
    seen.add(index);
  }
}

/** Applies an accepted file operation through services/fs.ts. */
async function applyFileOp(root: string, proposal: FileOpProposal) {
  switch (proposal.op) {
    case 'create': {
      const content = proposal.content ?? '';
      await createFile(root, proposal.path, content);
      return { path: proposal.path, content };
    }
    case 'rename':
      await rename(root, proposal.path, proposal.newPath ?? '');
      return undefined;
    case 'delete':
      await remove(root, proposal.path);
      return undefined;
  }
}

/**
 * Decides the review of `toolCallId`. The first decision wins: later ones throw a
 * ReviewConflictError. Edits are applied by the web app before it posts "accepted"; file
 * operations are applied here. If applying fails, the agent is told and the error is rethrown.
 */
export async function decideReview(
  root: string,
  pending: Pending,
  toolCallId: string,
  request: ReviewDecisionRequest,
): Promise<ReviewDecisionResponse> {
  const proposal = pending.peek(toolCallId);
  if (!proposal)
    throw new ReviewConflictError('This proposal was already decided or is no longer pending');

  if (proposal.type === 'edit') {
    const count = proposal.hunks.length;
    if (request.decision === 'accepted') {
      if (!request.hunks) throw new InvalidDecisionError('An accepted edit needs "hunks"');
      checkIndexes(
        request.hunks.map((h) => h.index),
        count,
        'Hunk',
      );
    }
    if (request.decision === 'stale') {
      checkIndexes(
        request.currentRegions.map((r) => r.index),
        count,
        'Region',
      );
    }
  } else if (request.decision === 'stale') {
    throw new InvalidDecisionError('A file operation cannot be stale');
  }

  const taken = pending.take(toolCallId);
  if (!taken)
    throw new ReviewConflictError('This proposal was already decided or is no longer pending');

  let created: ReviewDecisionResponse['created'];
  if (proposal.type === 'file_op' && request.decision === 'accepted') {
    try {
      created = await applyFileOp(root, proposal);
    } catch (err) {
      taken.settle({ decision: 'failed', error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }
  taken.settle(request);
  return { toolCallId, decision: request.decision, ...(created ? { created } : {}) };
}
