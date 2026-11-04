// Completion without a language server: common commands and environments, and the labels
// of the open file after \ref{. texlab (see lsp.ts) replaces this when it is installed.

import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';

const ENVIRONMENTS = [
  'abstract',
  'align',
  'align*',
  'array',
  'center',
  'description',
  'document',
  'enumerate',
  'equation',
  'equation*',
  'figure',
  'flushleft',
  'flushright',
  'gather',
  'gather*',
  'itemize',
  'lstlisting',
  'matrix',
  'minipage',
  'multline',
  'pmatrix',
  'bmatrix',
  'proof',
  'quote',
  'split',
  'subfigure',
  'table',
  'tabular',
  'theorem',
  'lemma',
  'thebibliography',
  'verbatim',
];

const COMMANDS = [
  'begin',
  'end',
  'section',
  'subsection',
  'subsubsection',
  'paragraph',
  'chapter',
  'part',
  'label',
  'ref',
  'eqref',
  'cite',
  'caption',
  'includegraphics',
  'input',
  'include',
  'usepackage',
  'documentclass',
  'title',
  'author',
  'date',
  'maketitle',
  'tableofcontents',
  'item',
  'emph',
  'textbf',
  'textit',
  'texttt',
  'underline',
  'footnote',
  'url',
  'href',
  'frac',
  'sqrt',
  'sum',
  'int',
  'prod',
  'lim',
  'infty',
  'alpha',
  'beta',
  'gamma',
  'delta',
  'epsilon',
  'lambda',
  'mu',
  'pi',
  'sigma',
  'theta',
  'omega',
  'partial',
  'nabla',
  'cdot',
  'times',
  'leq',
  'geq',
  'neq',
  'approx',
  'mathbb',
  'mathcal',
  'mathrm',
  'left',
  'right',
  'hline',
  'centering',
  'newline',
  'newpage',
  'vspace',
  'hspace',
  'bibliography',
  'bibliographystyle',
  'newcommand',
  'renewcommand',
];

const environments: Completion[] = ENVIRONMENTS.map((label) => ({ label, type: 'type' }));
const commands: Completion[] = COMMANDS.map((name) => ({ label: `\\${name}`, type: 'keyword' }));

/** Every \label{…} name in `text`, once each, in order. */
export function labelsIn(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/\\label\{([^}\n]+)\}/g)) names.add(match[1] as string);
  return [...names];
}

export function latexCompletions(context: CompletionContext): CompletionResult | null {
  const env = context.matchBefore(/\\(?:begin|end)\{[^}\s]*$/);
  if (env) {
    return {
      from: env.from + env.text.indexOf('{') + 1,
      options: environments,
      validFor: /^[^}\s]*$/,
    };
  }
  const ref = context.matchBefore(/\\(?:ref|eqref|autoref|cref|Cref|pageref|nameref)\{[^}\s]*$/);
  if (ref) {
    const options = labelsIn(context.state.doc.toString()).map((label) => ({
      label,
      type: 'variable',
    }));
    return { from: ref.from + ref.text.indexOf('{') + 1, options, validFor: /^[^}\s]*$/ };
  }
  const command = context.matchBefore(/\\[a-zA-Z]*$/);
  if (command && (command.text.length > 1 || context.explicit)) {
    return { from: command.from, options: commands, validFor: /^\\[a-zA-Z]*$/ };
  }
  return null;
}
