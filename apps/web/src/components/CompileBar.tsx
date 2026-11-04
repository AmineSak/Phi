import { Monitor, Moon, Play, Settings, Sun } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

import { compile } from '../editor/session.ts';
import { openSettings, useProjectStore } from '../store/project-store.ts';
import { ProjectPicker } from './Project/ProjectPicker.tsx';
import { countEntries, useCompileStore } from '../store/compile-store.ts';
import { useEditorStore, type SaveStatus } from '../store/editor-store.ts';
import { setThemeMode, useThemeStore, type ThemeMode } from '../store/theme-store.ts';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const SAVE_LABEL: Record<SaveStatus, string> = {
  saved: 'Saved',
  unsaved: 'Unsaved changes',
  saving: 'Saving…',
  conflict: 'Not saved: changed on disk',
  error: 'Save failed',
};

function BuildCaption() {
  const { status, build, durationMs, entries, error } = useCompileStore();
  const { errors, warnings } = countEntries(entries);

  if (status === 'compiling') return <span>Compiling…</span>;
  if (status === 'error')
    return <span className="text-destructive">Compile did not run: {error}</span>;
  if (build === 0) return <span>Not compiled yet</span>;
  return (
    <span>
      <span className="font-semibold text-foreground">Build {build}</span>
      {/* The duration gives way first on narrow screens, so the save status stays visible. */}
      {durationMs !== null && (
        <span className="hidden sm:inline">{` · ${(durationMs / 1000).toFixed(1)} s`}</span>
      )}{' '}
      ·{' '}
      <span className={cn(errors > 0 && 'font-semibold text-destructive')}>
        {plural(errors, 'error')}
      </span>{' '}
      ·{' '}
      <span className={cn(warnings > 0 && 'font-semibold text-warning')}>
        {plural(warnings, 'warning')}
      </span>
    </span>
  );
}

function SaveCaption() {
  const status = useEditorStore((s) =>
    s.activePath ? (s.saveStatus[s.activePath] ?? 'saved') : null,
  );
  if (!status) return null;
  return (
    <>
      {' · '}
      <span className={cn((status === 'conflict' || status === 'error') && 'text-destructive')}>
        {SAVE_LABEL[status]}
      </span>
    </>
  );
}

const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } satisfies Record<ThemeMode, unknown>;

function ThemeMenu() {
  const mode = useThemeStore((s) => s.mode);
  const Icon = THEME_ICON[mode];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={`Theme: ${mode}`} />}
      >
        <Icon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={mode} onValueChange={(v) => setThemeMode(v as ThemeMode)}>
          <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function CompileBar() {
  const compiling = useCompileStore((s) => s.status === 'compiling');
  const hasProject = useProjectStore((s) => s.root !== null);

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b bg-card px-3">
      <SidebarTrigger className="md:hidden" aria-label="Show project files" />
      <span className="hidden font-semibold whitespace-nowrap sm:inline">Phi</span>
      <Separator
        orientation="vertical"
        className="mx-1 hidden data-vertical:h-5 data-vertical:self-center sm:block"
      />
      <ProjectPicker />
      <Button
        onClick={() => void compile()}
        disabled={compiling || !hasProject}
        aria-keyshortcuts="Meta+S Control+S"
      >
        {compiling ? <Spinner /> : <Play />}
        {compiling ? 'Compiling' : 'Compile'}
      </Button>
      <p className="min-w-0 truncate text-xs text-muted-foreground" aria-live="polite">
        <BuildCaption />
        <SaveCaption />
      </p>
      <div className="ml-auto flex items-center gap-3">
        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground md:flex">
          <KbdGroup>
            <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
            <Kbd>S</Kbd>
          </KbdGroup>
          save and compile
        </span>
        <ThemeMenu />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Settings"
          title="Settings"
          onClick={() => openSettings()}
        >
          <Settings />
        </Button>
      </div>
    </header>
  );
}
