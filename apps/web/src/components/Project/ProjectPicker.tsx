import { useEffect, useState } from 'react';
import type { TemplateInfo } from '@phi/shared';
import { ChevronsUpDown, Download, FolderOpen, FolderPlus, Plus } from 'lucide-react';

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
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Spinner } from '@/components/ui/spinner';

import { api } from '../../api/client.ts';
import { createProject, downloadProject, switchProject } from '../../editor/project.ts';
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

/** Deployed (SPEC 9.2): the project folders on the server, refreshed when shown. */
function useProjects(active: boolean): { name: string; path: string }[] {
  const [projects, setProjects] = useState<{ name: string; path: string }[]>([]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    api
      .projects()
      .then((r) => current && setProjects(r.projects))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [active]);
  return projects;
}

/** Deployed (SPEC 9.2): a name and a template; the server creates the folder and opens it. */
export function NewProjectForm({ onCreated }: { onCreated?: () => void }) {
  const [name, setName] = useState('');
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [template, setTemplate] = useState('blank');
  const switching = useProjectStore((s) => s.switching);
  const error = useProjectStore((s) => s.error);
  useEffect(() => {
    api
      .templates()
      .then(setTemplates)
      .catch(() => {});
  }, []);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (name.trim() && (await createProject(name, template))) onCreated?.();
      }}
    >
      <Field>
        <FieldLabel htmlFor="new-project-name">Name</FieldLabel>
        <Input
          id="new-project-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My thesis"
          maxLength={64}
          spellCheck={false}
          autoFocus
        />
      </Field>
      <Field>
        <FieldLabel id="new-project-template">Template</FieldLabel>
        <RadioGroup
          aria-labelledby="new-project-template"
          value={template}
          onValueChange={(value) => setTemplate(String(value))}
          className="gap-0 overflow-hidden rounded-lg border border-border"
        >
          {templates.map((t) => (
            <label
              key={t.id}
              className="flex cursor-pointer items-start gap-3 border-b border-border px-3 py-2.5 last:border-b-0 has-data-checked:bg-accent/70"
            >
              <RadioGroupItem value={t.id} className="mt-0.5" />
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">{t.name}</span>
                <span className="text-xs text-muted-foreground">{t.description}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
        <FieldDescription>Saved on the server, next to your other projects.</FieldDescription>
      </Field>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={switching || !name.trim()} className="self-end">
        {switching && <Spinner />}
        Create project
      </Button>
    </form>
  );
}

/** Deployed, before any project is open: the server's projects as buttons. */
export function ManagedProjects() {
  const projects = useProjects(true);
  if (projects.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {projects.map((p) => (
        <li key={p.path}>
          <Button
            variant="ghost"
            className="w-full justify-start"
            onClick={() => void switchProject(p.path)}
          >
            <FolderOpen />
            <span className="truncate">{p.name}</span>
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
  const managed = useProjectStore((s) => s.managed);
  const switching = useProjectStore((s) => s.switching);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<'open' | 'new' | null>(null);
  const projects = useProjects(managed && menuOpen);
  // Deployed, the list is the server's folders; locally, the recent ones.
  const choices = managed ? projects.map((p) => p.path) : recent;

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="min-w-0 shrink gap-1.5 px-2"
              aria-label="Project"
              title={managed ? undefined : (root ?? undefined)}
            />
          }
        >
          {switching ? <Spinner /> : <FolderOpen />}
          <span className="truncate font-semibold">{root ? folderName(root) : 'No project'}</span>
          <ChevronsUpDown className="text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className={managed ? 'w-72' : 'w-96'}>
          {choices.length > 0 && (
            <DropdownMenuGroup>
              <DropdownMenuLabel>{managed ? 'Projects' : 'Recent projects'}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={root ?? ''}
                onValueChange={(path: string) => void switchProject(path)}
              >
                {choices.map((path) => (
                  <DropdownMenuRadioItem
                    key={path}
                    value={path}
                    closeOnClick
                    className="items-start"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{folderName(path)}</span>
                      {!managed && (
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {path}
                        </span>
                      )}
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          )}
          {choices.length > 0 && <DropdownMenuSeparator />}
          {managed ? (
            <DropdownMenuItem onClick={() => setDialog('new')}>
              <Plus />
              New project…
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => setDialog('open')}>
              <FolderPlus />
              Open folder…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem disabled={!root} onClick={() => void downloadProject()}>
            <Download />
            Download as .zip
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-lg">
          {dialog === 'new' ? (
            <>
              <DialogHeader>
                <DialogTitle>New project</DialogTitle>
                <DialogDescription>
                  The agent stops any work in the current project; unsaved edits are saved first.
                </DialogDescription>
              </DialogHeader>
              <NewProjectForm onCreated={() => setDialog(null)} />
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Open a project</DialogTitle>
                <DialogDescription>
                  The absolute path of the folder holding your .tex files. The agent stops any work
                  in the current project; unsaved edits are saved first.
                </DialogDescription>
              </DialogHeader>
              <OpenFolderForm onOpened={() => setDialog(null)} />
              <DialogFooter showCloseButton />
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
