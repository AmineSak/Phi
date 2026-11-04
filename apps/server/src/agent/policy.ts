// Tool-level enforcement of SPEC 1.3 (no preamble, \documentclass, .cls or .sty changes unless
// the user's current message asks) for changes the agent proposes (SPEC 2.2).

import { posix } from 'node:path';

import type { BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core';
import { applyEdits, PROPOSE_EDIT, PROPOSE_FILE_OP, type TextEdit } from '@phi/shared';

import { hasDocumentClass } from '../services/root-file.ts';
import type { Workspace } from './workspace.ts';

/** A project change a proposal tool call would make. */
export type ProposedChange =
  | { kind: 'edit'; path: string; edits: TextEdit[] }
  | { kind: 'create'; path: string; content: string }
  | { kind: 'rename'; path: string; to: string }
  | { kind: 'delete'; path: string };

const BEGIN_DOCUMENT = '\\begin{document}';
const PROTECTED_EXTENSIONS = ['.cls', '.sty'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isEdit = (v: unknown): v is TextEdit =>
  isRecord(v) && typeof v.oldText === 'string' && typeof v.newText === 'string';

/** The change a propose_edit / propose_file_op call would make; null for other tools. */
export function changeOf(toolName: string, args: unknown): ProposedChange | null {
  if (!isRecord(args) || typeof args.path !== 'string') return null;
  const { path, edits, op, newPath, content } = args;
  if (toolName === PROPOSE_EDIT && Array.isArray(edits) && edits.every(isEdit)) {
    return { kind: 'edit', path, edits };
  }
  if (toolName !== PROPOSE_FILE_OP) return null;
  if (op === 'create')
    return { kind: 'create', path, content: typeof content === 'string' ? content : '' };
  if (op === 'rename' && typeof newPath === 'string') return { kind: 'rename', path, to: newPath };
  if (op === 'delete') return { kind: 'delete', path };
  return null;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `message` names `term` as a whole word (case-insensitive). */
function mentions(message: string, term: string): boolean {
  return new RegExp(`(^|[^\\w])${escapeRegex(term)}(?=[^\\w]|$)`, 'i').test(message);
}

/** Package and class names in \usepackage{a,b} / \documentclass{c} / \RequirePackage{d}. */
function packageNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(
    /\\(?:usepackage|RequirePackage|documentclass)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g,
  )) {
    names.push(
      ...(match[1] ?? '')
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean),
    );
  }
  return names;
}

const isProtectedFile = (path: string) =>
  PROTECTED_EXTENSIONS.includes(posix.extname(path).toLowerCase());

/** Whether an edit to `content` touches the text before \begin{document}. */
function touchesPreamble(content: string, edits: TextEdit[]): boolean {
  const begin = content.indexOf(BEGIN_DOCUMENT);
  if (begin === -1) return false;
  let hunks;
  try {
    // Locate the edits as the tool will (fuzzy matching included).
    ({ hunks } = applyEdits(content, edits));
  } catch {
    return false; // an edit that doesn't apply fails in the tool itself, not here
  }
  return hunks.some((h) => h.start < begin + BEGIN_DOCUMENT.length);
}

/** What the change touches that SPEC 1.3 protects, with the words that count as asking for it. */
async function protectedPart(
  change: ProposedChange,
  workspace: Workspace,
): Promise<{ what: string; terms: string[] } | null> {
  const paths = change.kind === 'rename' ? [change.path, change.to] : [change.path];
  const file = paths.find(isProtectedFile);
  if (file) {
    const name = posix.basename(file);
    return {
      what: `${name}, a ${name.toLowerCase().endsWith('.cls') ? 'class' : 'package'} file`,
      terms: [file, name, name.replace(/\.[^.]+$/, '')],
    };
  }
  if (change.kind !== 'edit' && change.kind !== 'delete') return null;

  let content: string;
  try {
    content = await workspace.readText(change.path);
  } catch {
    return null; // a missing file has no preamble; the change tool reports the real error
  }
  if (!hasDocumentClass(content)) return null;
  const name = posix.basename(change.path);
  const terms = ['preamble', change.path, name];
  if (change.kind === 'delete') return { what: `${name}, a root document`, terms };
  if (!touchesPreamble(content, change.edits)) return null;
  const edited = change.edits.map((e) => `${e.oldText}\n${e.newText}`).join('\n');
  return {
    what: `the preamble of ${change.path} (before \\begin{document})`,
    terms: [...terms, 'documentclass', ...packageNames(edited)],
  };
}

/**
 * Null when `change` is allowed, else the reason to block it: it touches a preamble, a root
 * document, or a .cls/.sty file, and `userMessage` mentions none of the preamble, the package
 * or the file.
 */
export async function preambleBlockReason(
  change: ProposedChange,
  userMessage: string,
  workspace: Workspace,
): Promise<string | null> {
  const part = await protectedPart(change, workspace);
  if (!part || part.terms.some((term) => mentions(userMessage, term))) return null;
  return (
    `Blocked: this changes ${part.what}, which you may only change when the user's current ` +
    'message asks for it. Do not try to work around this. Ask the user whether they want this ' +
    'change, say exactly what you would change and why, and wait for their answer.'
  );
}

/** Text of the latest user message in a pi context ('' if there is none). */
function latestUserText(context: BeforeToolCallContext['context']): string {
  const message = context.messages.findLast((m) => m.role === 'user');
  if (!message || message.role !== 'user') return '';
  if (typeof message.content === 'string') return message.content;
  return message.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

/** A pi beforeToolCall that blocks protected changes (SPEC 1.3, 2.2). */
export function preambleGuard(workspace: Workspace) {
  return async ({
    toolCall,
    args,
    context,
  }: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
    const change = changeOf(toolCall.name, args);
    if (!change) return undefined;
    const reason = await preambleBlockReason(change, latestUserText(context), workspace);
    return reason ? { block: true, reason } : undefined;
  };
}
