import { useEffect, useState } from 'react';
import { TriangleAlert } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';

import { contextLabel, loadSettings, updateSettings } from '../../agent/settings.ts';
import { openSettings, useProjectStore } from '../../store/project-store.ts';
import { ProviderIcon } from './ProviderIcon.tsx';
import { ProviderList } from './ProviderList.tsx';

type ModelChoice = { id: string; name: string; contextWindow: number };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function ModelField() {
  const settings = useProjectStore((s) => s.settings)!;
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const selected = settings.models.find((m) => m.id === settings.model) ?? null;
  const fromEnv = settings.modelSource === 'env';
  const provider = settings.providers.find((p) => p.id === settings.provider);

  return (
    <Field>
      <FieldLabel htmlFor="settings-model">
        Model
        {provider && (
          <span className="flex items-center gap-1 font-normal text-muted-foreground">
            · <ProviderIcon id={provider.id} className="size-3.5" /> {provider.name}
          </span>
        )}
      </FieldLabel>
      <Combobox<ModelChoice>
        items={settings.models}
        value={selected}
        disabled={fromEnv || saving}
        itemToStringLabel={(m) => m.name}
        itemToStringValue={(m) => m.id}
        isItemEqualToValue={(a, b) => a.id === b.id}
        onValueChange={async (choice) => {
          if (!choice || choice.id === settings.model) return;
          setSaving(true);
          setError(null);
          try {
            await updateSettings({ model: choice.id });
          } catch (err) {
            setError(message(err));
          }
          setSaving(false);
        }}
      >
        <ComboboxInput id="settings-model" placeholder="Search models…" />
        <ComboboxContent>
          <ComboboxEmpty>No model matches.</ComboboxEmpty>
          <ComboboxList>
            {(m: ModelChoice) => (
              <ComboboxItem key={m.id} value={m}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{m.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {m.id}
                    {m.contextWindow ? ` · ${contextLabel(m.contextWindow)}` : ''}
                  </span>
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      <FieldDescription>
        {fromEnv
          ? 'Set by LLM_MODEL in the .env file, which overrides this setting.'
          : `Used from your next message on. ${settings.models.length} ${provider?.name ?? settings.provider} models; each provider remembers its own choice.`}
      </FieldDescription>
      {(error ?? settings.modelError) && (
        <p className="text-sm text-destructive">{error ?? settings.modelError}</p>
      )}
    </Field>
  );
}

/** The provider section: the list, or a note in offline (faux) mode. */
function ProviderField() {
  const settings = useProjectStore((s) => s.settings)!;
  return (
    <Field>
      <FieldLabel id="settings-provider">Model provider</FieldLabel>
      {settings.providers.length ? (
        <>
          <FieldDescription className="-mt-1">
            Each provider keeps its own key and model. Click one to use it.
          </FieldDescription>
          <ProviderList />
        </>
      ) : (
        <FieldDescription>
          The offline model is in use (<code className="font-mono">LLM_PROVIDER=faux</code>); it
          needs no key.
        </FieldDescription>
      )}
    </Field>
  );
}

/** Whether the editor completes from texlab (labels, citations, files) or the basic list. */
function CompletionField() {
  const completion = useProjectStore((s) => s.completion);
  if (!completion) return null;
  return (
    <Field>
      <FieldLabel>Completion</FieldLabel>
      {completion.available ? (
        <FieldDescription>
          {completion.version ?? 'texlab'}: commands, environments, labels, citations and file paths
          from the whole project.
        </FieldDescription>
      ) : (
        <FieldDescription>
          Basic commands and environments only. For labels, citations and file paths from the whole
          project, install texlab (<code className="font-mono">brew install texlab</code>) and
          reload this page.
        </FieldDescription>
      )}
    </Field>
  );
}

/** SPEC 7.1: the model from pi's catalog and the API key, stored server-side. */
export function SettingsDialog() {
  const open = useProjectStore((s) => s.settingsOpen);
  const settings = useProjectStore((s) => s.settings);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFailed(false);
    void loadSettings().then(() => setFailed(!useProjectStore.getState().settings));
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => openSettings(next)}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Changes apply from your next message, without a restart.
          </DialogDescription>
        </DialogHeader>
        {failed && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>Could not load the settings from the server.</AlertDescription>
          </Alert>
        )}
        {settings ? (
          <FieldGroup>
            <ProviderField />
            <ModelField />
            <CompletionField />
          </FieldGroup>
        ) : (
          !failed && <Spinner />
        )}
      </DialogContent>
    </Dialog>
  );
}
