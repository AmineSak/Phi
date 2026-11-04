import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
} from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { forEachDiagnostic, lintKeymap } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';

import { environmentPairs } from './environments.ts';

/** The compile entry (E1, W2…) the user last selected, shown ringed in the margin. */
export const setActiveEntry = StateEffect.define<string | null>();

export const activeEntryField = StateField.define<string | null>({
  create: () => null,
  update: (value, tr) => {
    for (const effect of tr.effects) if (effect.is(setActiveEntry)) value = effect.value;
    return value;
  },
});

class EntryRefWidget extends WidgetType {
  constructor(
    readonly id: string,
    readonly kind: string,
    readonly active: boolean,
    readonly onSelect: (id: string) => void,
  ) {
    super();
  }

  override eq(other: EntryRefWidget): boolean {
    return other.id === this.id && other.kind === this.kind && other.active === this.active;
  }

  toDOM(): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `cm-entry-ref cm-entry-ref-${this.kind}${this.active ? ' cm-entry-ref-active' : ''}`;
    button.textContent = `(${this.id})`;
    button.title = `Show ${this.id} in the entries list`;
    button.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', () => this.onSelect(this.id));
    return button;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** Right-margin "(E1)" references for each diagnostic, like equation numbers. */
function entryReferences(onSelect: (id: string) => void): Extension {
  const build = (view: EditorView): DecorationSet => {
    const active = view.state.field(activeEntryField);
    const byLine = new Map<number, Range<Decoration>[]>();
    forEachDiagnostic(view.state, (d, from) => {
      if (!d.source) return;
      const line = view.state.doc.lineAt(from);
      const widget = new EntryRefWidget(d.source, d.severity, d.source === active, onSelect);
      const list = byLine.get(line.number) ?? [];
      // One faint tint per line, coloured by its first (most severe, errors come first) entry.
      if (list.length === 0) {
        list.push(Decoration.line({ class: `cm-entry-line-${d.severity}` }).range(line.from));
      }
      list.push(Decoration.widget({ widget, side: 1 }).range(line.to));
      byLine.set(line.number, list);
    });
    const ranges = [...byLine.values()].flat().sort((a, b) => a.from - b.from);
    return Decoration.set(ranges, true);
  };

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.transactions.some((t) => t.effects.length > 0)) {
          this.decorations = build(update.view);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

const latexHighlight = HighlightStyle.define([
  { tag: [tags.tagName, tags.keyword], color: 'var(--syntax-command)' },
  { tag: [tags.atom, tags.number], color: 'var(--syntax-math)' },
  { tag: tags.comment, color: 'var(--muted-foreground)', fontStyle: 'italic' },
  { tag: [tags.bracket, tags.paren, tags.squareBracket], color: 'var(--syntax-punct)' },
  { tag: tags.string, color: 'var(--syntax-math)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--card)', color: 'var(--card-foreground)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', fontSize: '13px', lineHeight: '1.65' },
  '.cm-content': { padding: '8px 0', caretColor: 'var(--primary)' },
  '.cm-line': { padding: '0 16px 0 8px' },
  '.cm-gutters': {
    backgroundColor: 'var(--card)',
    color: 'color-mix(in oklch, var(--muted-foreground) 70%, transparent)',
    border: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 14px', minWidth: '44px' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklch, var(--accent) 55%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--foreground)' },
  '.cm-cursor': { borderLeftColor: 'var(--primary)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in oklch, var(--primary) 22%, transparent) !important',
  },
  '.cm-matchingBracket': {
    backgroundColor: 'color-mix(in oklch, var(--primary) 16%, transparent)',
    outline: 'none',
  },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in oklch, var(--primary) 10%, transparent)' },
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--destructive)',
    textUnderlineOffset: '4px',
    textDecorationSkipInk: 'none',
  },
  '.cm-lintRange-warning': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--warning)',
    textUnderlineOffset: '4px',
    textDecorationSkipInk: 'none',
  },
  '.cm-entry-line-error': {
    backgroundColor: 'color-mix(in oklch, var(--destructive) 7%, transparent)',
  },
  '.cm-entry-line-warning': {
    backgroundColor: 'color-mix(in oklch, var(--warning) 8%, transparent)',
  },
  '.cm-entry-ref': {
    float: 'right',
    marginLeft: '12px',
    padding: '0 4px',
    font: '600 12px/1.65 var(--font-sans)',
    fontVariantNumeric: 'tabular-nums',
    background: 'none',
    border: '1px solid transparent',
    borderRadius: '4px',
    cursor: 'pointer',
  },
  '.cm-entry-ref-error': { color: 'var(--destructive)' },
  '.cm-entry-ref-warning': { color: 'var(--warning)' },
  '.cm-entry-ref:hover': { borderColor: 'var(--border)' },
  '.cm-entry-ref:focus-visible': { outline: '2px solid var(--ring)', outlineOffset: '1px' },
  '.cm-entry-ref-active': { borderColor: 'currentColor' },
  '.cm-tooltip': {
    backgroundColor: 'var(--popover)',
    color: 'var(--popover-foreground)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    boxShadow: '0 4px 12px -2px rgb(0 0 0 / 0.12)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete': { padding: '4px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-mono)',
    fontSize: '12.5px',
    maxHeight: '15em',
    minWidth: '220px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    display: 'flex',
    alignItems: 'baseline',
    padding: '3px 8px',
    borderRadius: 'calc(var(--radius-md) - 2px)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent)',
    color: 'var(--accent-foreground)',
  },
  '.cm-completionIcon': { display: 'none' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '600' },
  '.cm-completionDetail': {
    marginLeft: 'auto',
    paddingLeft: '16px',
    fontFamily: 'var(--font-sans)',
    fontSize: '11.5px',
    fontStyle: 'normal',
    color: 'var(--muted-foreground)',
  },
  '.cm-diagnostic': { fontFamily: 'var(--font-sans)', fontSize: '13px', padding: '4px 8px' },
  '.cm-diagnostic-error': { borderLeft: '1px solid var(--destructive)' },
  '.cm-diagnostic-warning': { borderLeft: '1px solid var(--warning)' },
  '.cm-diagnosticSource': { fontWeight: '600', opacity: '1' },
  '.cm-panels': { backgroundColor: 'var(--card)', color: 'var(--card-foreground)' },
  '.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
});

/** The "Show in PDF" command's key (SPEC 6.4). */
export const SHOW_IN_PDF_KEY = 'Mod-Alt-j';

/**
 * Extensions for one file's EditorState. `onSelectEntry` fires when a margin ref is clicked,
 * `onShowInPdf` on the "Show in PDF" command.
 */
export function latexExtensions(
  onSelectEntry: (id: string) => void,
  onShowInPdf: () => void,
): Extension[] {
  return [
    lineNumbers(),
    highlightSpecialChars(),
    EditorView.lineWrapping,
    StreamLanguage.define(stex),
    syntaxHighlighting(latexHighlight),
    theme,
    highlightActiveLineGutter(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    activeEntryField,
    entryReferences(onSelectEntry),
    environmentPairs(),
    keymap.of([
      { key: SHOW_IN_PDF_KEY, run: () => (onShowInPdf(), true), preventDefault: true },
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      ...lintKeymap,
      indentWithTab,
    ]),
  ];
}
