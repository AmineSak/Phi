import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  fileKind,
  PROPOSE_FILE_OP,
  type FileOpProposal,
  type ReviewToolDetails,
} from '@phi/shared';
import { Type } from 'typebox';

import { resolveInProject } from '../../services/paths.ts';
import type { Decision, Pending } from '../pending.ts';
import { CANCELLED_TEXT, oneLine, rejectReason, requestReview } from './review.ts';
import { textContent } from './types.ts';

export const snippet = `${PROPOSE_FILE_OP}: propose creating, renaming or deleting a file; the user reviews it.`;
export const guidelines = [
  `Deleting with ${PROPOSE_FILE_OP} moves the file to the project's trash; still say why it should go.`,
];

const parameters = Type.Object({
  op: Type.Union([Type.Literal('create'), Type.Literal('rename'), Type.Literal('delete')]),
  path: Type.String({ description: 'File path relative to the project root' }),
  newPath: Type.Optional(Type.String({ description: 'For rename: the new path' })),
  content: Type.Optional(
    Type.String({ description: "For create: the new file's text (default empty)" }),
  ),
  rationale: Type.String({ description: 'One line for the user: why' }),
});

async function exists(root: string, path: string): Promise<boolean> {
  return Bun.file(resolveInProject(root, path))
    .stat()
    .then(
      () => true,
      () => false,
    );
}

/** Checks the operation can be applied now, so the user only reviews ones that can. */
async function validate(root: string, { op, path, newPath, content }: FileOpProposal) {
  resolveInProject(root, path);
  if (op === 'create') {
    if (fileKind(path) !== 'text')
      throw new Error(`Only text files can be created; ${path} is not one.`);
    if (await exists(root, path))
      throw new Error(`${path} already exists; use propose_edit to change it.`);
    return;
  }
  if (content !== undefined) throw new Error('"content" is only for op "create".');
  if (!(await exists(root, path))) throw new Error(`${path} does not exist.`);
  if (op === 'rename') {
    if (!newPath) throw new Error('op "rename" needs "newPath".');
    resolveInProject(root, newPath);
    if (await exists(root, newPath)) throw new Error(`${newPath} already exists.`);
  }
}

function resultText(proposal: FileOpProposal, decision: Decision): string {
  const { op, path, newPath } = proposal;
  switch (decision.decision) {
    case 'accepted':
      if (op === 'create') return `The user accepted; ${path} was created.`;
      if (op === 'rename') return `The user accepted; ${path} was renamed to ${newPath}.`;
      return `The user accepted; ${path} was moved to the project's trash.`;
    case 'rejected':
      return `The user rejected the ${op} of ${path}; nothing changed. ${rejectReason(decision.reason)}`;
    case 'cancelled':
      return CANCELLED_TEXT;
    case 'failed':
      throw new Error(`The user accepted, but the ${op} failed: ${decision.error}`);
    case 'stale':
      throw new Error('Unexpected "stale" decision for a file operation');
  }
}

export function createProposeFileOpTool(
  root: string,
  pending: Pending,
): AgentTool<typeof parameters, ReviewToolDetails> {
  return {
    name: PROPOSE_FILE_OP,
    label: 'Propose file change',
    description:
      'Propose creating a text file (with content), renaming a file (newPath), or deleting one ' +
      '(moved to the trash). The user reviews it; it is applied only if they accept.',
    parameters,
    execute: async (toolCallId, { op, path, newPath, content, rationale }, signal, onUpdate) => {
      const proposal: FileOpProposal = {
        id: toolCallId,
        type: 'file_op',
        op,
        path,
        ...(newPath === undefined ? {} : { newPath }),
        ...(content === undefined ? {} : { content }),
        rationale: oneLine(rationale),
      };
      await validate(root, proposal);
      const decision = await requestReview(proposal, pending, signal, onUpdate);
      const text = resultText(proposal, decision);
      return {
        content: textContent(text),
        details: {
          proposal,
          outcome: decision.decision === 'failed' ? 'accepted' : decision.decision,
        },
      };
    },
  };
}
