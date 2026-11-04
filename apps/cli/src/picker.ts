// A one-question menu: arrow keys (or j/k, or the item's number) move, Enter chooses,
// Esc / Ctrl+C / q cancels. Draws in place, below whatever is already on screen.

export interface Choice {
  label: string;
  hint?: string;
}

export type Step = { index: number } | { chosen: number } | { cancelled: true };

const UP = ['\x1b[A', '\x1bOA', 'k'];
const DOWN = ['\x1b[B', '\x1bOB', 'j', '\t'];
const CANCEL = ['\x1b', '\x03', 'q'];

/** What a key press does to the highlighted `index` among `count` items (wraps around). */
export function step(index: number, count: number, key: string): Step {
  if (UP.includes(key)) return { index: (index - 1 + count) % count };
  if (DOWN.includes(key)) return { index: (index + 1) % count };
  if (key === '\r' || key === '\n') return { chosen: index };
  if (CANCEL.includes(key)) return { cancelled: true };
  const digit = Number(key);
  if (key.length === 1 && Number.isInteger(digit) && digit >= 1 && digit <= count) {
    return { chosen: digit - 1 };
  }
  return { index };
}

const bold = (s: string, color: boolean) => (color ? `\x1b[1m${s}\x1b[22m` : s);
const dim = (s: string, color: boolean) => (color ? `\x1b[2m${s}\x1b[22m` : s);
const cyan = (s: string, color: boolean) => (color ? `\x1b[96m${s}\x1b[39m` : s);

/** The menu's lines with `index` highlighted. */
export function render(title: string, choices: Choice[], index: number, color: boolean): string[] {
  const width = Math.max(...choices.map((c) => c.label.length));
  return [
    `  ${bold(title, color)}`,
    '',
    ...choices.map((c, i) => {
      const label = c.label.padEnd(width);
      const hint = c.hint ? `  ${dim(c.hint, color)}` : '';
      return i === index
        ? `  ${cyan(`❯ ${i + 1}. ${bold(label, color)}`, color)}${hint}`
        : `    ${dim(`${i + 1}.`, color)} ${label}${hint}`;
    }),
    '',
    `  ${dim('↑/↓ move · Enter choose · Esc cancel', color)}`,
  ];
}

/** Asks on the terminal; resolves with the chosen index, or null when cancelled. */
export function pick(
  title: string,
  choices: Choice[],
  { color = true }: { color?: boolean } = {},
): Promise<number | null> {
  const { stdin, stdout } = process;
  let index = 0;
  let drawn = 0;
  const draw = () => {
    const lines = render(title, choices, index, color);
    // Back to the menu's first line, clear to the end of the screen, redraw.
    stdout.write(`${drawn ? `\x1b[${drawn}A\r` : ''}\x1b[0J${lines.join('\n')}\n`);
    drawn = lines.length;
  };

  return new Promise((resolve) => {
    const finish = (result: number | null) => {
      stdin.off('data', onKey);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\x1b[?25h');
      resolve(result);
    };
    const onKey = (data: Buffer) => {
      const next = step(index, choices.length, data.toString('utf8'));
      if ('cancelled' in next) return finish(null);
      if ('chosen' in next) {
        index = next.chosen;
        draw();
        return finish(index);
      }
      index = next.index;
      draw();
    };
    stdout.write('\x1b[?25l');
    draw();
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onKey);
  });
}
