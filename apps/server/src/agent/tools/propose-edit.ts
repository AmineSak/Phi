import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  applyEdits,
  fileKind,
  lineAt,
  PROPOSE_EDIT,
  PROPOSE_FILE_OP,
  READ_FILE,
  type EditProposal,
  type ReviewToolDetails,
} from '@phi/shared';
import { Type, type Static } from 'typebox';

import { resolveInProject } from '../../services/paths.ts';
import type { Decision, Pending } from '../pending.ts';
import type { Workspace } from '../workspace.ts';
import { CANCELLED_TEXT, oneLine, rejectReason, requestReview } from './review.ts';
import { textContent } from './types.ts';

export const snippet = `${PROPOSE_EDIT}: propose replacing text in one file; the user reviews it, and accepts or rejects each hunk.`;
export const guidelines = [
  `Every change goes through ${PROPOSE_EDIT} or ${PROPOSE_FILE_OP} and is applied only if the user accepts it.`,
  `In ${PROPOSE_EDIT}, each oldText must appear exactly once in the file as it is now: copy it from ${READ_FILE} output and include enough surrounding text to be unique.`,
  'Keep LaTeX commands, labels, citation keys and references intact in text you change.',
];

const parameters = Type.Object({
  path: Type.String({ description: 'File path relative to the project root' }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({
        description: 'Exact current text to replace; must occur exactly once in the file',
      }),
      newText: Type.String({ description: 'Replacement text' }),
    }),
    {
      minItems: 1,
      description: 'One or more replacements; all are matched against the current file',
    },
  ),
  rationale: Type.String({ description: 'One line for the user: what this changes and why' }),
});

/**
 * Repairs argument shapes real models send (seen with OpenRouter's free models): `edits` as a
 * JSON-encoded string, or one edit object instead of a list. Anything else is left for
 * pi's validation to report.
 */
export function repairArguments(args: unknown): unknown {
  if (typeof args !== 'object' || args === null) return args;
  let { edits } = args as { edits?: unknown };
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits);
    } catch {
      return args;
    }
  }
  if (edits && typeof edits === 'object' && !Array.isArray(edits)) edits = [edits];
  return { ...args, edits };
}

/** Text of files whose changes may affect the PDF (SPEC 2.4). */
const COMPILED = /\.(tex|bib|sty|cls|bst)$/i;

function quote(text: string): string {
  return `"""\n${text}\n"""`;
}

/** What the model learns about the decision. */
function resultText(proposal: EditProposal, decision: Decision): string {
  const { path, hunks, baseText } = proposal;
  const where = (i: number) => `hunk ${i + 1} (line ${lineAt(baseText, hunks[i]!.start)})`;
  switch (decision.decision) {
    case 'accepted': {
      const decisions = decision.hunks ?? [];
      const applied = decisions.filter((h) => h.accepted).sort((a, b) => a.index - b.index);
      if (applied.length === 0) {
        return `The user accepted none of the ${hunks.length} hunks for ${path}; nothing was applied.`;
      }
      const lines = [
        applied.length === hunks.length
          ? `The user accepted all ${hunks.length} hunks; ${path} is changed and saved.`
          : `The user accepted ${applied.map((h) => where(h.index)).join(', ')} of ${hunks.length}; ${path} is changed and saved. The other hunks were rejected and not applied.`,
      ];
      for (const h of applied) {
        if (h.finalText !== undefined && h.finalText !== hunks[h.index]!.newText) {
          lines.push(
            `The user edited ${where(h.index)} before accepting; it now reads:\n${quote(h.finalText)}`,
          );
        }
      }
      if (COMPILED.test(path)) lines.push('Compile now to check the result.');
      return lines.join('\n\n');
    }
    case 'rejected':
      return `The user rejected the proposal for ${path}; nothing was applied. ${rejectReason(decision.reason)}`;
    case 'stale':
      return [
        `Nothing was applied: ${path} changed while the proposal waited, so these hunks no longer match.`,
        ...decision.currentRegions.map(
          (r) => `Current text around ${where(r.index)}:\n${quote(r.text)}`,
        ),
        'The file changed; re-read it and propose again.',
      ].join('\n\n');
    case 'cancelled':
      return CANCELLED_TEXT;
    case 'failed':
      throw new Error(decision.error);
  }
}

export function createProposeEditTool(
  root: string,
  workspace: Workspace,
  pending: Pending,
): AgentTool<typeof parameters, ReviewToolDetails> {
  return {
    name: PROPOSE_EDIT,
    label: 'Propose edit',
    description:
      'Propose replacing text in one existing text file. Each edit replaces oldText (which must ' +
      'occur exactly once in the file as the user currently has it) with newText. The user reviews ' +
      'the proposal and may accept, edit or reject each hunk; the result tells you what was applied.',
    parameters,
    prepareArguments: (args) => repairArguments(args) as Static<typeof parameters>,
    execute: async (toolCallId, { path, edits, rationale }, signal, onUpdate) => {
      resolveInProject(root, path);
      if (fileKind(path) !== 'text')
        throw new Error(`${path} is not a text file; it cannot be edited.`);
      let baseText: string;
      try {
        baseText = await workspace.readText(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(
            `${path} does not exist. To create it, use ${PROPOSE_FILE_OP} with op "create".`,
          );
        }
        throw err;
      }
      // A mismatch throws here, before the user sees anything: the model fixes it and retries.
      const { hunks, diff } = applyEdits(baseText, edits);
      const proposal: EditProposal = {
        id: toolCallId,
        type: 'edit',
        path,
        rationale: oneLine(rationale),
        hunks,
        diff,
        baseText,
      };
      const decision = await requestReview(proposal, pending, signal, onUpdate);
      const text = resultText(proposal, decision);
      return {
        content: textContent(text),
        details: {
          proposal,
          outcome: decision.decision === 'failed' ? 'accepted' : decision.decision,
          ...(decision.decision === 'accepted' && decision.hunks ? { hunks: decision.hunks } : {}),
        },
      };
    },
  };
}
