import type { Diagnostic } from '@codemirror/lint';
import type { Text } from '@codemirror/state';

import type { Entry } from './entries.ts';

/** `\name` at the end of "Undefined control sequence \name". */
const CULPRIT = /(\\[A-Za-z@]+)$/;

/**
 * Turns located entries into CodeMirror diagnostics for one document. The entry id travels
 * as `source`, so the margin markers and the error list can point at each other.
 * Lines past the end of the document clamp to the last line.
 */
export function toDiagnostics(doc: Text, entries: readonly Entry[]): Diagnostic[] {
  return entries.flatMap((entry) => {
    if (entry.line === null) return [];
    const line = doc.line(Math.min(Math.max(entry.line, 1), doc.lines));
    let from = line.from;
    let to = line.to;

    // Mark just the offending macro when the message names one and the line contains it.
    const culprit = CULPRIT.exec(entry.message)?.[1];
    const at = culprit ? line.text.indexOf(culprit) : -1;
    if (culprit && at >= 0) {
      from = line.from + at;
      to = from + culprit.length;
    } else {
      // Skip leading indentation so the underline starts at the text.
      from += line.text.length - line.text.trimStart().length;
    }

    return [
      {
        from,
        to,
        severity: entry.kind,
        source: entry.id,
        message: entry.message,
      } satisfies Diagnostic,
    ];
  });
}
