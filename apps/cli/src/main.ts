#!/usr/bin/env bun
// `phi`: create a LaTeX project from a template and open it in the browser editor.
//   phi init [path] [--template <id>] [--no-open]
//   phi open [path] [--no-open]

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { parse, resolve, sep } from 'node:path';

import { logo } from './art.ts';
import { choosePort, openBrowser, openOnRunning, startServer, waitUntilUp } from './launch.ts';
import { pick } from './picker.ts';
import {
  copyTemplate,
  listTemplates,
  TEMPLATES_DIR,
  TemplateConflictError,
  type Template,
} from './templates.ts';

const USAGE = `Usage:
  phi init [path]   Create a project from a template in path (default: here) and open it
  phi open [path]   Open an existing project folder (default: here)

Options:
  --template <id>   Skip the menu (blank, beamer, paper, thesis)
  --no-open         Don't open the browser
  -h, --help        Show this help`;

export interface Args {
  command: 'init' | 'open' | 'help';
  path: string;
  template: string | null;
  open: boolean;
}

export class UsageError extends Error {}

export function parseArgs(argv: string[]): Args {
  const args: Args = { command: 'help', path: '.', template: null, open: true };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '-h' || arg === '--help') return { ...args, command: 'help' };
    else if (arg === '--no-open') args.open = false;
    else if (arg === '--template' || arg === '-t') {
      const value = argv[++i];
      if (!value) throw new UsageError('--template needs a template id');
      args.template = value;
    } else if (arg.startsWith('--template=')) args.template = arg.slice('--template='.length);
    else if (arg.startsWith('-')) throw new UsageError(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  const [command, path, extra] = positional;
  if (command === undefined) return args;
  if (command !== 'init' && command !== 'open') throw new UsageError(`Unknown command: ${command}`);
  if (extra !== undefined) throw new UsageError(`Unexpected argument: ${extra}`);
  return { ...args, command, path: path ?? '.' };
}

/**
 * The project folder for `path`. Refuses the home folder, the disk root and their parents: they
 * hold far too many files for a project (and protected ones), and templates would land there.
 */
export function projectFolder(path: string, home = homedir()): string {
  const root = resolve(path);
  if (root === parse(root).root || root === home || home.startsWith(root + sep)) {
    throw new UsageError(
      `${root} is too broad to be a project. Name a folder for it, e.g.: phi init my-paper`,
    );
  }
  return root;
}

const useColor = () => !!process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);
const say = (line = '') => process.stdout.write(`${line}\n`);

async function chooseTemplate(templates: Template[], id: string | null): Promise<Template | null> {
  if (id) {
    const found = templates.find((t) => t.id === id);
    if (!found) {
      throw new UsageError(
        `No template "${id}". Available: ${templates.map((t) => t.id).join(', ')}`,
      );
    }
    return found;
  }
  if (!process.stdin.isTTY) {
    throw new UsageError(
      `Not an interactive terminal: choose with --template (${templates.map((t) => t.id).join(', ')})`,
    );
  }
  const index = await pick(
    'Start from a template',
    templates.map((t) => ({ label: t.name, hint: t.description })),
    { color: useColor() },
  );
  return index === null ? null : (templates[index] ?? null);
}

/** Serves `root` and opens the browser; resolves when the server we started stops. */
async function serve(root: string, open: boolean): Promise<void> {
  const { port, running } = await choosePort(Number(process.env.PORT ?? 3000));
  const url = `http://127.0.0.1:${port}/`;
  if (running) {
    await openOnRunning(port, root);
    say(`Opened in the Phi server already running at ${paint('96', url)}`);
    if (open) openBrowser(url);
    return;
  }
  const server = startServer(port, root);
  let stopping = false;
  const stop = () => {
    stopping = true;
    server.kill('SIGINT');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    await waitUntilUp(port, server);
  } catch (err) {
    // Ctrl+C while starting: not an error.
    if (stopping) return;
    throw err;
  }
  say(`Phi is running at ${paint('96', url)} ${paint('2', '· Ctrl+C to stop')}`);
  if (open) openBrowser(url);
  await server.exited;
}

async function init(args: Args): Promise<number> {
  const root = projectFolder(args.path);
  if (existsSync(root) && !statSync(root).isDirectory()) {
    throw new UsageError(`${root} is a file, not a folder`);
  }
  say();
  for (const line of logo(useColor())) say(`  ${line}`);
  say();
  const templates = listTemplates();
  if (!templates.length) throw new UsageError(`No templates found in ${TEMPLATES_DIR}`);
  const template = await chooseTemplate(templates, args.template);
  if (!template) {
    say('Cancelled.');
    return 130;
  }
  try {
    const files = copyTemplate(template, root);
    say();
    say(`${paint('32', '✓')} ${template.name} → ${root} (${files.length} files)`);
  } catch (err) {
    if (!(err instanceof TemplateConflictError)) throw err;
    throw new UsageError(
      `${root} already has ${err.paths.join(', ')}. Nothing was changed.\n` +
        `Open it as it is with: phi open ${args.path}`,
    );
  }
  await serve(root, args.open);
  return 0;
}

async function openExisting(args: Args): Promise<number> {
  const root = projectFolder(args.path);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new UsageError(`${root} is not a folder. Create a project with: phi init ${args.path}`);
  }
  await serve(root, args.open);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.command === 'init') return await init(args);
    if (args.command === 'open') return await openExisting(args);
    say(USAGE);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${paint('31', 'phi:')} ${message}\n`);
    if (err instanceof UsageError && message.startsWith('Unknown')) say(`\n${USAGE}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
