// The <editor_state> block: what the user sees, added to each LLM request (SPEC 5.7).
// It is added by transformContext, so it reaches the model but never the stored transcript.

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { fileKind, type CompileResult } from '@phi/shared';

import { lastCompile } from '../services/project-compile.ts';
import { resolveRoot } from '../services/root-file.ts';
import type { Workspace } from './workspace.ts';

const TAG = 'editor_state';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function compileLine(result: CompileResult | undefined): string {
  if (!result) return 'Last compile: none since the server started';
  const status = result.ok ? 'succeeded' : 'failed';
  return `Last compile: ${result.root} ${status}, ${plural(result.errors.length, 'error')}, ${plural(result.warnings.length, 'warning')}`;
}

async function rootLine(root: string, activeFile: string | null): Promise<string> {
  try {
    const active = activeFile && fileKind(activeFile) === 'text' ? activeFile : undefined;
    return `Compile root: ${(await resolveRoot(root, active)).root}`;
  } catch (err) {
    return `Compile root: none (${err instanceof Error ? err.message : String(err)})`;
  }
}

/** The block's text, short enough to send with every request. */
export async function editorStateText(root: string, workspace: Workspace): Promise<string> {
  const snapshot = workspace.snapshot;
  const lines: string[] = [];
  if (!snapshot?.activeFile) {
    lines.push('Active file: none');
  } else {
    const cursor = snapshot.cursorLine ? `, cursor on line ${snapshot.cursorLine}` : '';
    lines.push(`Active file: ${snapshot.activeFile}${cursor}`);
  }
  lines.push(await rootLine(root, snapshot?.activeFile ?? null));
  if (snapshot?.selection) {
    const { from, to, text } = snapshot.selection;
    const range = from === to ? `line ${from}` : `lines ${from}-${to}`;
    // Keep a selection from closing the block early.
    const quoted = text.replaceAll(`</${TAG}>`, `<\\/${TAG}>`);
    lines.push(`Selection (${range}):\n"""\n${quoted}\n"""`);
  }
  const dirty = snapshot?.dirtyFiles.map((f) => f.path) ?? [];
  if (dirty.length > 0) {
    lines.push(`Unsaved edits in: ${dirty.join(', ')} (your read and search tools see them)`);
  }
  lines.push(compileLine(lastCompile(root)));
  const reverted = snapshot?.revertedToolCallIds ?? [];
  if (reverted.length > 0) {
    lines.push(`The user reverted your edits from tool calls: ${reverted.join(', ')}`);
  }
  return `<${TAG}>\n${lines.join('\n')}\n</${TAG}>`;
}

/**
 * Returns `messages` with the block prepended to a copy of the latest user message. Messages
 * are copied, never mutated, so the agent's transcript keeps the user's words only.
 */
export function withEditorState(messages: AgentMessage[], block: string): AgentMessage[] {
  const index = messages.findLastIndex((m) => m.role === 'user');
  const target = messages[index];
  if (!target || target.role !== 'user') return messages;
  const original =
    typeof target.content === 'string'
      ? [{ type: 'text' as const, text: target.content }]
      : target.content;
  const copy = [...messages];
  copy[index] = { ...target, content: [{ type: 'text', text: block }, ...original] };
  return copy;
}

/** A pi transformContext that adds the current editor state; never throws (pi's contract). */
export function editorStateTransform(root: string, workspace: Workspace) {
  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    try {
      return withEditorState(messages, await editorStateText(root, workspace));
    } catch (err) {
      console.error('Could not build <editor_state>:', err);
      return messages;
    }
  };
}
