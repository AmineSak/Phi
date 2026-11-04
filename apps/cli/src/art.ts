// The PHI logo, as ANSI-colored block art, from the original `echo -e` script. Escapes are
// written as \x1b (a template literal can't hold \033); not String.raw, because Bun's
// transpiler would turn the block characters inside it into literal "▄" text.

const RAW = `\x1b[0;97m▄\x1b[0;37m▄\x1b[0;96m▄▄▄▄▄\x1b[0;36m▄▄▄▄▄▄▄▄\x1b[0;37m    \x1b[0;97m▄\x1b[0;37m▄\x1b[0;96m▄▄▄▄▄▄\x1b[0;37m  \x1b[0;97m▄\x1b[0;37m▄\x1b[0;96m▄\x1b[0;36m▄▄▄▄▄\x1b[0;37m \x1b[0;97m▄\x1b[0;37m▄\x1b[0;96m▄▄▄▄▄▄\x1b[0m
\x1b[0;96;47m▄\x1b[0;37m              \x1b[0;36m▀▄\x1b[0;37m  \x1b[0;96;47m▄\x1b[0;37m      \x1b[0;96;46m▓\x1b[0;37m  \x1b[0;96;47m▄\x1b[0;37m      \x1b[0;36m█\x1b[0;37m \x1b[0;96;47m▄\x1b[0;37m      \x1b[0;96;46m▓\x1b[0m
\x1b[0;96m█\x1b[0;37m               \x1b[0;36m▐▌\x1b[0;37m \x1b[0;96m█\x1b[0;37m      \x1b[0;96;46m▒\x1b[0;37m  \x1b[0;96;46m▒\x1b[0;37m     \x1b[0;36m▒█\x1b[0;37m \x1b[0;96m█\x1b[0;37m      \x1b[0;96;46m▒\x1b[0m
\x1b[0;96;46m▓\x1b[0;37m      \x1b[0;96;46m▒\x1b[0;96m▀\x1b[0;36m▀\x1b[0;90;46m░\x1b[0;37m     \x1b[0;36m░\x1b[0;90;46m▒\x1b[0;37m \x1b[0;96;46m▓\x1b[0;37m      \x1b[0;96;46m░\x1b[0;37m  \x1b[0;96;46m░\x1b[0;37m     \x1b[0;36m░█\x1b[0;37m \x1b[0;96;46m▓\x1b[0;37m      \x1b[0;96;46m░\x1b[0m
\x1b[0;96;46m▒\x1b[0;37m      \x1b[0;96;46m░\x1b[0;37m  \x1b[0;90;46m▒\x1b[0;37m     \x1b[0;90m▐▌\x1b[0;37m \x1b[0;96;46m▒\x1b[0;37m      \x1b[0;36m█\x1b[0;37m  \x1b[0;36m█\x1b[0;37m      \x1b[0;36m█\x1b[0;37m \x1b[0;96;46m▒\x1b[0;37m      \x1b[0;36m█\x1b[0m
\x1b[0;96;46m░\x1b[0;37m      \x1b[0;36m▀▀\x1b[0;90m▀▀\x1b[0;37m   \x1b[0;90m▄▄▀\x1b[0;37m  \x1b[0;96;46m░\x1b[0;37m      \x1b[0;36m█▄▄█\x1b[0;37m    \x1b[0;36m┼┼█\x1b[0;37m \x1b[0;96;46m░\x1b[0;37m      \x1b[0;36m█\x1b[0m
\x1b[0;36m█┼\x1b[0;37m     \x1b[0;96;46m▒\x1b[0;90m▀▀▀▀▀▀\x1b[0;37m     \x1b[0;36m█┼\x1b[0;37m \x1b[0;36m┼\x1b[0;37m          \x1b[0;36m┼\x1b[0;96m┼┼\x1b[0;36m█\x1b[0;37m \x1b[0;36m█┼\x1b[0;37m     \x1b[0;36m█\x1b[0m
\x1b[0;36m█┼┼\x1b[0;37m   \x1b[0;36m┼\x1b[0;96;46m░\x1b[0;37m    \x1b[0;36m░\x1b[0;37m      \x1b[0;36m█┼┼┼┼\x1b[0;37m \x1b[0;36m┼█▀▀█┼\x1b[0;37m   \x1b[0;36m┼\x1b[0;96m┼\x1b[0;36m█\x1b[0;37m \x1b[0;36m█┼\x1b[0;37m    \x1b[0;36m┼█\x1b[0m
\x1b[0;36m█┼\x1b[0;96m┼\x1b[0;36m┼┼┼\x1b[0;96m┼\x1b[0;90;46m░\x1b[0;37m  \x1b[0;36m·░░░\x1b[0;37m     \x1b[0;36m█┼\x1b[0;96m┼┼┼\x1b[0;36m┼\x1b[0;96m┼\x1b[0;90;46m░\x1b[0;37m  \x1b[0;36m█\x1b[0;96m┼\x1b[0;36m┼┼\x1b[0;37m \x1b[0;36m┼\x1b[0;96m┼\x1b[0;90;46m░\x1b[0;37m \x1b[0;36m█┼\x1b[0;96m┼\x1b[0;37m  \x1b[0;36m┼\x1b[0;96m┼\x1b[0;90;46m░\x1b[0m
\x1b[0;36m█┼\x1b[0;96m┼\x1b[0;97m┼┼\x1b[0;96m┼\x1b[0;36m┼\x1b[0;90;46m▒\x1b[0;37m  \x1b[0;36m░▒▒░\x1b[0;37m     \x1b[0;36m█┼\x1b[0;96m┼\x1b[0;97m┼┼\x1b[0;96m┼\x1b[0;36m┼\x1b[0;90;46m▒\x1b[0;37m  \x1b[0;36m█\x1b[0;96m┼\x1b[0;97m┼\x1b[0;96m┼\x1b[0;36m┼\x1b[0;96m┼\x1b[0;36m┼\x1b[0;90;46m▒\x1b[0;37m \x1b[0;36m█┼\x1b[0;96m┼\x1b[0;97m┼┼\x1b[0;96m┼\x1b[0;36m┼\x1b[0;90;46m▒\x1b[0m
\x1b[0;36m█┼┼\x1b[0;96m┼┼\x1b[0;36m┼┼\x1b[0;90;46m▓\x1b[0;37m  \x1b[0;36m░░░\x1b[0;37m      \x1b[0;36m█┼┼\x1b[0;96m┼┼\x1b[0;36m┼┼\x1b[0;90;46m▓\x1b[0;37m  \x1b[0;36m█┼\x1b[0;96m┼┼┼\x1b[0;36m┼┼\x1b[0;90;46m▓\x1b[0;37m \x1b[0;36m█┼┼\x1b[0;96m┼┼\x1b[0;36m┼┼\x1b[0;90;46m▓\x1b[0m
\x1b[0;36m▀▀\x1b[0;90m▀▀▀▀▀▀\x1b[0;37m   \x1b[0;36m░\x1b[0;37m \x1b[0;36m·\x1b[0;37m     \x1b[0;36m▀▀▀▀▀▀\x1b[0;90m▀▀\x1b[0;37m  \x1b[0;36m▀▀▀▀▀▀\x1b[0;90m▀▀\x1b[0;37m \x1b[0;36m▀▀▀▀▀▀\x1b[0;90m▀▀\x1b[0m`;

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Removes color and cursor escapes (for NO_COLOR, pipes, and tests). */
export const stripAnsi = (text: string) => text.replace(ANSI, '');

/** The logo's lines; plain shapes when `color` is false. */
export function logo(color: boolean): string[] {
  const lines = RAW.split('\n');
  return color ? lines : lines.map(stripAnsi);
}
