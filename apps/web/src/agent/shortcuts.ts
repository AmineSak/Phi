// Chat shortcuts from the editor (SPEC 5.8): "Ask about selection" and "Fix with AI".

import { MAX_SELECTION_CHARS, type CompileError } from '@phi/shared';

import { setDraft } from '../store/agent-store.ts';
import { sendMessage } from './client.ts';

export interface QuotedSelection {
  path: string;
  from: number;
  to: number;
  text: string;
}

/** A Markdown quote of the selection, followed by an empty line to type the question on. */
export function quoteSelection({ path, from, to, text }: QuotedSelection): string {
  const range = from === to ? `line ${from}` : `lines ${from}-${to}`;
  const cut = text.length > MAX_SELECTION_CHARS ? `${text.slice(0, MAX_SELECTION_CHARS)}…` : text;
  const quoted = cut
    .replace(/\n+$/, '')
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
  return `About ${path}, ${range}:\n${quoted}\n\n`;
}

/** "Fix this compile error: <file>:<line>: <message>", leaving out what the log didn't give. */
export function fixErrorMessage({ file, line, message }: CompileError): string {
  const location = [file || null, line === null ? null : String(line)].filter(Boolean).join(':');
  return `Fix this compile error: ${location ? `${location}: ` : ''}${message}`;
}

/** Prefills the composer with a quote of the selection and focuses it. */
export function askAboutSelection(selection: QuotedSelection): void {
  setDraft(quoteSelection(selection), { focus: true });
}

/** Sends the error to the agent straight away. */
export function fixWithAi(error: CompileError): Promise<void> {
  return sendMessage(fixErrorMessage(error));
}
