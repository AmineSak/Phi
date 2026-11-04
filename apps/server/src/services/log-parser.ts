import type { CompileError } from '@phi/shared';

export interface ParsedLog {
  errors: CompileError[];
  /** First 20 distinct warnings. */
  warnings: CompileError[];
  /** Last 40 lines of the log. */
  tail: string;
}

const MAX_WARNINGS = 20;
const TAIL_LINES = 40;
/** How far past an error line to look for its `l.N` context and location. */
const LOOKAHEAD = 15;

/** `./chapters/intro.tex:12: message`, from -file-line-error. */
const FILE_LINE = /^(.+?\.[A-Za-z0-9]+):(\d+): (.*)$/;
const CONTEXT_LINE = /^l\.(\d+) (.*)$/;
const WARNING = /^(?:LaTeX|Package \S+|Class \S+)(?: Font)? Warning: /;
/** Continuation of a multi-line package/font warning: `(natbib)    rest of message`. */
const CONTINUATION = /^\([^)\s]+\)\s+(.*)$/;
const BAD_BOX = /^(?:Over|Under)full \\[hv]box /;

/**
 * Pulls errors, warnings and a tail out of a pdflatex log produced with -file-line-error.
 * File is '' when the log doesn't say which file an error or warning came from.
 */
export function parseLatexLog(log: string): ParsedLog {
  const lines = log.split(/\r?\n/);
  const errors: CompileError[] = [];
  const warnings: CompileError[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    const located = FILE_LINE.exec(line);
    if (located) {
      const [, file = '', lineNo = '', message = ''] = located;
      if (!isConsequence(message)) {
        errors.push({
          file: cleanFile(file),
          line: Number(lineNo),
          message: withCulprit(message, lines, i),
        });
      }
      continue;
    }

    if (line.startsWith('! ')) {
      const message = line.slice(2).trim();
      if (message === 'Emergency stop.') {
        // Only worth reporting when no earlier error explains it, e.g. a missing \end{document}.
        if (errors.length === 0) errors.push(emergencyStop(lines, i));
      } else if (!isConsequence(message)) {
        errors.push({ ...findLocation(lines, i), message: withCulprit(message, lines, i) });
      }
      continue;
    }

    if (WARNING.test(line)) {
      let message = line;
      while (CONTINUATION.test(lines[i + 1] ?? '')) {
        message += ` ${CONTINUATION.exec(lines[++i] ?? '')?.[1] ?? ''}`;
      }
      warnings.push({ file: '', line: numberAfter(message, /on input line (\d+)/), message });
      continue;
    }

    if (BAD_BOX.test(line)) {
      warnings.push({ file: '', line: numberAfter(line, /at lines? (\d+)/), message: line });
    }
  }

  return {
    errors: dedupe(errors),
    warnings: dedupe(warnings).slice(0, MAX_WARNINGS),
    tail: tail(lines),
  };
}

/** Lines TeX prints because of an earlier error, not causes in themselves. */
function isConsequence(message: string): boolean {
  const text = message.trim();
  return text === 'Emergency stop.' || text.startsWith('==> Fatal error occurred');
}

/** For a bare `! ...` error: line from the `l.N` context, file from a later `file:N:` line. */
function findLocation(lines: string[], start: number): Pick<CompileError, 'file' | 'line'> {
  let line: number | null = null;
  for (let i = start + 1; i < Math.min(lines.length, start + LOOKAHEAD); i++) {
    const text = lines[i] ?? '';
    if (text.startsWith('! ')) break;
    const located = FILE_LINE.exec(text);
    if (located) return { file: cleanFile(located[1] ?? ''), line: Number(located[2]) };
    line ??= numberAfter(text, CONTEXT_LINE);
  }
  return { file: '', line };
}

function emergencyStop(lines: string[], start: number): CompileError {
  const reason = lines
    .slice(start + 1, start + LOOKAHEAD)
    .find((l) => l.startsWith('*** '))
    ?.replace(/^\*\*\* \((.*)\)$/, '$1');
  return {
    ...findLocation(lines, start),
    message: reason ? `Emergency stop: ${reason}` : 'Emergency stop.',
  };
}

/** TeX breaks the `l.N` context right after the offending token; name it in the message. */
function withCulprit(message: string, lines: string[], start: number): string {
  if (!message.startsWith('Undefined control sequence')) return message;
  for (let i = start + 1; i < Math.min(lines.length, start + 5); i++) {
    const context = CONTEXT_LINE.exec(lines[i] ?? '');
    const culprit = context?.[2]?.match(/(\\(?:[A-Za-z@]+|.))\s*$/)?.[1];
    if (culprit) return `Undefined control sequence ${culprit}`;
  }
  return message;
}

function numberAfter(text: string, pattern: RegExp): number | null {
  const match = pattern.exec(text);
  return match ? Number(match[1]) : null;
}

function cleanFile(file: string): string {
  return file.replace(/^\.\//, '');
}

function dedupe(items: CompileError[]): CompileError[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.file}\0${item.line}\0${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tail(lines: string[]): string {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? '').trim() === '') end--;
  return lines.slice(Math.max(0, end - TAIL_LINES), end).join('\n');
}
