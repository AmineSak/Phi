import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { parseLatexLog } from '../log-parser.ts';

// Real latexmk logs; regenerate with `bun apps/server/src/services/tests/__fixtures__/generate.ts`.
const fixture = async (name: string) =>
  parseLatexLog(await Bun.file(join(import.meta.dir, '__fixtures__', `${name}.log`)).text());

describe('fixtures', () => {
  test('undefined-command: names the macro, one error per occurrence', async () => {
    const { errors, warnings } = await fixture('undefined-command');
    expect(errors).toEqual([
      { file: 'main.tex', line: 3, message: 'Undefined control sequence \\foo' },
      { file: 'main.tex', line: 5, message: 'Undefined control sequence \\foo' },
      // \bar is a math accent, so using it in text is a different error.
      { file: 'main.tex', line: 5, message: 'Missing $ inserted.' },
      { file: 'main.tex', line: 6, message: 'Missing $ inserted.' },
    ]);
    expect(warnings).toEqual([]);
  });

  test('missing-end-env: the unclosed environment', async () => {
    expect((await fixture('missing-end-env')).errors).toEqual([
      {
        file: 'main.tex',
        line: 6,
        message: 'LaTeX Error: \\begin{itemize} on input line 3 ended by \\end{document}.',
      },
    ]);
  });

  test('missing-end-document: the emergency stop with its reason', async () => {
    expect((await fixture('missing-end-document')).errors).toEqual([
      { file: '', line: null, message: 'Emergency stop: job aborted, no legal \\end found' },
    ]);
  });

  test('missing-package: located via the following emergency stop, which is dropped', async () => {
    expect((await fixture('missing-package')).errors).toEqual([
      {
        file: 'main.tex',
        line: 3,
        message: "LaTeX Error: File `nonexistentpackage.sty' not found.",
      },
    ]);
  });

  test('missing-input: the missing file and the \\input line', async () => {
    expect((await fixture('missing-input')).errors).toEqual([
      {
        file: 'main.tex',
        line: 3,
        message: "LaTeX Error: File `chapters/missing.tex' not found.",
      },
    ]);
  });

  test('error-in-subfile: attributed to the included file', async () => {
    expect((await fixture('error-in-subfile')).errors).toEqual([
      {
        file: 'chapters/intro.tex',
        line: 5,
        message: 'LaTeX Error: \\begin{enumerate} on input line 3 ended by \\end{itemize}.',
      },
    ]);
  });

  test('bad-citation: no errors, undefined citation and reference warnings', async () => {
    const { errors, warnings } = await fixture('bad-citation');
    expect(errors).toEqual([]);
    expect(warnings).toEqual([
      {
        file: '',
        line: 3,
        message: "LaTeX Warning: Citation `knuth1984' on page 1 undefined on input line 3.",
      },
      {
        file: '',
        line: 3,
        message: "LaTeX Warning: Citation `nobody2020' on page 1 undefined on input line 3.",
      },
      {
        file: '',
        line: 4,
        message: "LaTeX Warning: Reference `sec:nowhere' on page 1 undefined on input line 4.",
      },
      { file: '', line: null, message: 'LaTeX Warning: There were undefined references.' },
    ]);
  });

  test('warnings: duplicate labels, overfull boxes, multi-line font warnings', async () => {
    const { errors, warnings } = await fixture('warnings');
    expect(errors).toEqual([]);
    expect(warnings).toEqual([
      { file: '', line: null, message: "LaTeX Warning: Label `dup' multiply defined." },
      {
        file: '',
        line: 5,
        message: 'Overfull \\hbox (118.44548pt too wide) in paragraph at lines 5--6',
      },
      {
        file: '',
        line: 7,
        message:
          "LaTeX Font Warning: Font shape `OT1/cmss/m/scit' undefined using `OT1/cmss/m/sc' instead on input line 7.",
      },
      {
        file: '',
        line: 7,
        message:
          "LaTeX Font Warning: Font shape `OT1/cmss/m/sc' in size <10> not available Font shape `OT1/cmr/m/sc' tried instead on input line 7.",
      },
      { file: '', line: 9, message: 'Overfull \\hbox (80.33356pt too wide) detected at line 9' },
      { file: '', line: null, message: 'LaTeX Warning: There were multiply-defined labels.' },
    ]);
  });

  test('tail is the last 40 lines of the log', async () => {
    const { tail } = await fixture('warnings');
    expect(tail.split('\n')).toHaveLength(40);
    expect(tail).toContain('Output written on main.pdf');
  });
});

describe('synthetic logs', () => {
  test('deduplicates identical errors and warnings', () => {
    const log = [
      './main.tex:3: Undefined control sequence.',
      'l.3 \\foo',
      './main.tex:3: Undefined control sequence.',
      'l.3 \\foo',
      "LaTeX Warning: Citation `x' on page 1 undefined on input line 3.",
      "LaTeX Warning: Citation `x' on page 1 undefined on input line 3.",
    ].join('\n');
    const { errors, warnings } = parseLatexLog(log);
    expect(errors).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });

  test('keeps only the first 20 warnings', () => {
    const log = Array.from(
      { length: 30 },
      (_, i) => `Underfull \\hbox (badness 10000) in paragraph at lines ${i + 1}--${i + 1}`,
    ).join('\n');
    const { warnings } = parseLatexLog(log);
    expect(warnings).toHaveLength(20);
    expect(warnings[0]).toEqual({
      file: '',
      line: 1,
      message: 'Underfull \\hbox (badness 10000) in paragraph at lines 1--1',
    });
  });

  test('joins package warning continuation lines', () => {
    const log = [
      "Package natbib Warning: Citation `x' on page 1 undefined on input line 12.",
      'Package hyperref Warning: Token not allowed in a PDF string (Unicode):',
      "(hyperref)                removing `math shift' on input line 20.",
      'Class article Warning: Something odd.',
      'Underfull \\vbox (badness 10000) has occurred while \\output is active []',
    ].join('\n');
    expect(parseLatexLog(log).warnings).toEqual([
      {
        file: '',
        line: 12,
        message: "Package natbib Warning: Citation `x' on page 1 undefined on input line 12.",
      },
      {
        file: '',
        line: 20,
        message:
          "Package hyperref Warning: Token not allowed in a PDF string (Unicode): removing `math shift' on input line 20.",
      },
      { file: '', line: null, message: 'Class article Warning: Something odd.' },
      {
        file: '',
        line: null,
        message: 'Underfull \\vbox (badness 10000) has occurred while \\output is active []',
      },
    ]);
  });

  test('bare "!" errors without any location', () => {
    expect(parseLatexLog('! Undefined control sequence.\n<argument> \\oops').errors).toEqual([
      { file: '', line: null, message: 'Undefined control sequence.' },
    ]);
  });

  test('takes the line from l.N when no file:line follows', () => {
    expect(parseLatexLog('! LaTeX Error: Something.\n\nl.42 \\thing').errors).toEqual([
      { file: '', line: 42, message: 'LaTeX Error: Something.' },
    ]);
  });

  test('handles absolute and nested paths in file:line errors', () => {
    const log = '/usr/local/texlive/tex/latex/foo/foo.sty:12: Package foo Error: Bad option.';
    expect(parseLatexLog(log).errors).toEqual([
      {
        file: '/usr/local/texlive/tex/latex/foo/foo.sty',
        line: 12,
        message: 'Package foo Error: Bad option.',
      },
    ]);
  });

  test('an empty log yields nothing', () => {
    expect(parseLatexLog('')).toEqual({ errors: [], warnings: [], tail: '' });
  });
});
