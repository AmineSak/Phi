import { useState } from 'react';
import { ChevronsUpDown, FolderOpen, FolderPlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

import { switchProject } from '../../editor/project.ts';
import { folderName, useProjectStore } from '../../store/project-store.ts';

/** An absolute folder path input with an Open button; reports errors from the server. */
export function OpenFolderForm({ onOpened }: { onOpened?: () => void }) {
  const [path, setPath] = useState('');
  const switching = useProjectStore((s) => s.switching);
  const error = useProjectStore((s) => s.error);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (path.trim() && (await switchProject(path))) onOpened?.();
      }}
    >
      <div className="flex gap-2">
        <Input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/Users/you/Documents/thesis"
          aria-label="Project folder (absolute path)"
          spellCheck={false}
          autoFocus
          className="font-mono"
        />
        <Button type="submit" disabled={switching || !path.trim()}>
          {switching && <Spinner />}
          Open
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </form>
  );
}

/** Recent projects as buttons, for the screen shown before any project is open. */
export function RecentProjects() {
  const recent = useProjectStore((s) => s.recent);
  if (recent.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {recent.map((path) => (
        <li key={path}>
          <Button
            variant="ghost"
            className="h-auto w-full justify-start py-1.5 text-left"
            onClick={() => void switchProject(path)}
          >
            <FolderOpen />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{folderName(path)}</span>
              <span className="truncate font-mono text-xs text-muted-foreground">{path}</span>
            </span>
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** SPEC 4.4: the open project in the top bar; switch to a recent one or open a folder. */
export function ProjectPicker() {
  const root = useProjectStore((s) => s.root);
  const recent = useProjectStore((s) => s.recent);
  const switching = useProjectStore((s) => s.switching);
  const [opening, setOpening] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="min-w-0 shrink gap-1.5 px-2"
              aria-label="Project"
              title={root ?? undefined}
            />
          }
        >
          {switching ? <Spinner /> : <FolderOpen />}
          <span className="truncate font-semibold">{root ? folderName(root) : 'No project'}</span>
          <ChevronsUpDown className="text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-96">
          {recent.length > 0 && (
            <DropdownMenuGroup>
              <DropdownMenuLabel>Recent projects</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={root ?? ''}
                onValueChange={(path: string) => void switchProject(path)}
              >
                {recent.map((path) => (
                  <DropdownMenuRadioItem
                    key={path}
                    value={path}
                    closeOnClick
                    className="items-start"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{folderName(path)}</span>
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {path}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          )}
          {recent.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem onClick={() => setOpening(true)}>
            <FolderPlus />
            Open folder…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={opening} onOpenChange={setOpening}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Open a project</DialogTitle>
            <DialogDescription>
              The absolute path of the folder holding your .tex files. The agent stops any work in
              the current project; unsaved edits are saved first.
            </DialogDescription>
          </DialogHeader>
          <OpenFolderForm onOpened={() => setOpening(false)} />
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    </>
  );
}
