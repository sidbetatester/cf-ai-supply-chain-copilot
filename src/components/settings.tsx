import { createContext, useContext, useEffect, useState } from "react";
import type { useAgent } from "agents/react";
import { Badge, Button, Switch, Text } from "@cloudflare/kumo";
import {
  ArrowCounterClockwiseIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  LockSimpleIcon,
  PlusIcon,
  TrashIcon,
  WarningIcon,
  XIcon
} from "@phosphor-icons/react";
import type { SettingsAgent } from "../agents/settings-agent";
import {
  CUSTOM_PLUGIN,
  type Catalog,
  type EffectivePlugin,
  type ItemKind,
  type Overrides,
  type PromptInfo,
  type SettingsAccess,
  type SkillInfo,
  type WorkflowInfo,
  type WorkflowStep
} from "../plugins/catalog";
import { Tip } from "./tip";

export type SettingsConnection = ReturnType<
  typeof useAgent<SettingsAgent, Overrides>
>;

type EditableKind = "skill" | "prompt" | "workflow";
interface Selection {
  kind: ItemKind;
  name: string;
  /** Creating a new custom item of `kind` (name is chosen in the editor). */
  isNew?: boolean;
}

const KIND_LABEL: Record<EditableKind, string> = {
  skill: "skill",
  prompt: "command",
  workflow: "workflow"
};

/** Starting values for new custom items. */
const NEW_ITEM = {
  skill: { description: "", always: false, body: "", modified: false },
  prompt: { description: "", argumentHint: "", body: "", modified: false },
  workflow: {
    description: "",
    argumentHint: "",
    steps: [{ name: "Step 1", prompt: "", tools: [] }] as WorkflowStep[],
    problems: [] as string[],
    modified: false
  }
};

const SECTIONS = [
  { key: "skills", kind: "skill", label: "Skills" },
  { key: "prompts", kind: "prompt", label: "Commands" },
  { key: "workflows", kind: "workflow", label: "Workflows" },
  { key: "tools", kind: "tool", label: "Tools" }
] as const;

/** Whether this viewer may edit; every editing control reads it. */
const CanEdit = createContext(false);

const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

/** Full-screen Settings: enable/disable plugin content and edit skills, commands and workflows. */
export function SettingsPanel({
  catalog,
  settings,
  onClose
}: {
  catalog: Catalog;
  settings: SettingsConnection;
  onClose: () => void;
}) {
  const [selection, setSelection] = useState<Selection>(() => ({
    kind: "plugin",
    name: catalog[0]?.id ?? ""
  }));
  const [error, setError] = useState<string>();
  const [resetAllCount, setResetAllCount] = useState(0);
  const [access, setAccess] = useState<SettingsAccess>();
  useEffect(() => {
    settings.stub
      .access()
      .then(setAccess, (e: unknown) => setError(errorMessage(e)));
  }, [settings]);
  const canEdit = !!access?.unlocked;

  /** Run a Settings RPC, surfacing validation errors from the agent. */
  const run = async (action: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await action();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };

  const toggle = (kind: ItemKind, name: string, enabled: boolean) =>
    run(() => settings.stub.setEnabled(kind, name, enabled));

  return (
    <CanEdit.Provider value={canEdit}>
      <div className="fixed inset-0 z-50 flex flex-col bg-kumo-elevated">
        <header className="flex items-center justify-between gap-3 px-4 py-3 bg-kumo-base border-b border-kumo-line">
          <div>
            <h2 className="text-lg font-semibold text-kumo-default">
              Settings
            </h2>
            <Text size="xs" variant="secondary">
              Changes apply to new messages immediately. Plugin files stay the
              defaults.
            </Text>
          </div>
          <div className="flex items-center gap-2">
            <Tip
              content={
                canEdit
                  ? "Discard every Settings change and restore the plugin defaults"
                  : "Read-only: unlock editing with the admin key"
              }
              side="bottom"
            >
              <Button
                variant="secondary"
                icon={<ArrowCounterClockwiseIcon size={16} />}
                disabled={!canEdit}
                onClick={() => {
                  if (confirm("Reset all Settings to the plugin defaults?"))
                    run(() => settings.stub.resetAll()).then(
                      (ok) => ok && setResetAllCount((n) => n + 1)
                    );
                }}
              >
                Reset all
              </Button>
            </Tip>
            <Tip
              content="Close Settings (changes are already saved)"
              side="bottom"
            >
              <Button
                variant="secondary"
                shape="square"
                aria-label="Close settings"
                icon={<XIcon size={16} />}
                onClick={onClose}
              />
            </Tip>
          </div>
        </header>

        {access && !access.unlocked && (
          <UnlockBar
            configured={access.configured}
            onUnlock={(key) =>
              run(async () => setAccess(await settings.stub.unlock(key)))
            }
          />
        )}

        {error && (
          <div
            role="alert"
            className="px-4 py-2 text-sm bg-red-500/10 text-red-600 dark:text-red-400 border-b border-red-500/20"
          >
            {error}
          </div>
        )}

        <div className="flex flex-1 min-h-0 flex-col md:flex-row">
          <nav className="md:w-80 shrink-0 overflow-y-auto border-b md:border-b-0 md:border-r border-kumo-line bg-kumo-base p-3 space-y-4 max-h-[40vh] md:max-h-none">
            {catalog.map((plugin) => (
              <PluginList
                key={plugin.id}
                plugin={plugin}
                selection={selection}
                onSelect={setSelection}
                onToggle={toggle}
              />
            ))}
          </nav>
          <main className="flex-1 min-w-0 overflow-y-auto p-4 md:p-6">
            <Editor
              key={`${resetAllCount}:${selection.kind}:${selection.name}:${!!selection.isNew}`}
              onSelect={setSelection}
              catalog={catalog}
              selection={selection}
              settings={settings}
              run={run}
              onToggle={toggle}
            />
          </main>
        </div>
      </div>
    </CanEdit.Provider>
  );
}

/** Read-only notice with the admin-key form that unlocks editing for this connection. */
function UnlockBar({
  configured,
  onUnlock
}: {
  configured: boolean;
  onUnlock: (key: string) => Promise<boolean>;
}) {
  const [key, setKey] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm bg-kumo-control border-b border-kumo-line">
      <LockSimpleIcon size={16} className="text-kumo-subtle shrink-0" />
      <span className="text-kumo-default">
        {configured
          ? "Read-only. Enter the admin key to edit Settings."
          : "Read-only. Editing is disabled because no admin key is configured for this deployment."}
      </span>
      {configured && (
        <form
          className="flex items-center gap-2 ml-auto"
          onSubmit={async (e) => {
            e.preventDefault();
            if (key && (await onUnlock(key))) setKey("");
          }}
        >
          <input
            type="password"
            autoComplete="off"
            aria-label="Admin key"
            placeholder="Admin key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="px-3 py-1 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-ring"
          />
          <Tip content="Allow editing in this browser tab until you reload">
            <Button type="submit" variant="primary" size="sm" disabled={!key}>
              Unlock editing
            </Button>
          </Tip>
        </form>
      )}
    </div>
  );
}

// ── Navigation ────────────────────────────────────────────────────────

function PluginList({
  plugin,
  selection,
  onSelect,
  onToggle
}: {
  plugin: EffectivePlugin;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onToggle: (kind: ItemKind, name: string, enabled: boolean) => void;
}) {
  const canEdit = useContext(CanEdit);
  const isCustom = plugin.id === CUSTOM_PLUGIN.id;
  const isSelected = (kind: ItemKind, name: string) =>
    !selection.isNew && selection.kind === kind && selection.name === name;
  return (
    <section>
      <Row
        label={plugin.name}
        sublabel={`v${plugin.version}`}
        selected={isSelected("plugin", plugin.id)}
        enabled={plugin.enabled}
        hint={plugin.description}
        onSelect={() => onSelect({ kind: "plugin", name: plugin.id })}
        onToggle={(on) => onToggle("plugin", plugin.id, on)}
        strong
      />
      {SECTIONS.map(({ key, kind, label }) =>
        plugin[key].length === 0 && !(isCustom && kind !== "tool") ? null : (
          <div key={key} className="mt-2">
            <div className="flex items-center justify-between">
              <Text size="xs" variant="secondary" bold>
                {label.toUpperCase()}
              </Text>
              {isCustom && kind !== "tool" && (
                <Tip
                  content={
                    canEdit
                      ? `Create a new ${KIND_LABEL[kind]}`
                      : "Read-only: unlock editing with the admin key"
                  }
                >
                  <Button
                    variant="ghost"
                    size="xs"
                    icon={<PlusIcon size={12} />}
                    disabled={!canEdit}
                    aria-label={`New ${KIND_LABEL[kind]}`}
                    onClick={() => onSelect({ kind, name: "", isNew: true })}
                  >
                    New
                  </Button>
                </Tip>
              )}
            </div>
            <ul className="mt-1 space-y-0.5">
              {plugin[key].map((item) => (
                <li key={item.name}>
                  <Row
                    label={
                      kind === "prompt" || kind === "workflow"
                        ? `/${item.name}`
                        : item.name
                    }
                    selected={isSelected(kind, item.name)}
                    enabled={item.enabled}
                    locked={!plugin.enabled}
                    modified={item.modified}
                    warning={
                      !!item.shadowedBy ||
                      ("problems" in item && item.problems.length > 0)
                    }
                    hint={
                      item.shadowedBy
                        ? `Inactive: the ${item.shadowedBy} plugin defines the same name`
                        : item.description
                    }
                    onSelect={() => onSelect({ kind, name: item.name })}
                    onToggle={(on) => onToggle(kind, item.name, on)}
                  />
                </li>
              ))}
            </ul>
          </div>
        )
      )}
    </section>
  );
}

function Row({
  label,
  sublabel,
  selected,
  enabled,
  locked,
  modified,
  warning,
  strong,
  hint,
  onSelect,
  onToggle
}: {
  label: string;
  /** Shown as the row's tooltip (usually the item's description). */
  hint: string;
  sublabel?: string;
  selected: boolean;
  enabled: boolean;
  locked?: boolean;
  modified?: boolean;
  warning?: boolean;
  strong?: boolean;
  onSelect: () => void;
  onToggle: (on: boolean) => void;
}) {
  const canEdit = useContext(CanEdit);
  return (
    <div
      className={`flex items-center gap-2 rounded-lg px-2 py-1 ${selected ? "bg-kumo-control" : "hover:bg-kumo-control"}`}
    >
      <Tip content={hint} side="right" block>
        <button
          type="button"
          onClick={onSelect}
          className={`flex-1 min-w-0 flex items-center gap-1.5 text-left text-sm ${enabled ? "text-kumo-default" : "text-kumo-subtle line-through"} ${strong ? "font-semibold" : "font-mono"}`}
        >
          <span className="truncate">{label}</span>
          {sublabel && (
            <span className="text-xs text-kumo-subtle font-normal">
              {sublabel}
            </span>
          )}
          {modified && (
            <span
              className="size-1.5 rounded-full bg-kumo-brand shrink-0"
              title="Edited"
            />
          )}
          {warning && (
            <WarningIcon
              size={12}
              className="text-amber-500 shrink-0"
              aria-label="Has problems"
            />
          )}
        </button>
      </Tip>
      <Tip
        content={
          !canEdit
            ? "Read-only: unlock editing with the admin key"
            : locked
              ? "Its plugin is turned off; turn the plugin on first"
              : enabled
                ? `Turn off ${label}`
                : `Turn on ${label}`
        }
      >
        <Switch
          size="sm"
          checked={enabled}
          disabled={locked || !canEdit}
          onCheckedChange={onToggle}
          aria-label={`${enabled ? "Disable" : "Enable"} ${label}`}
        />
      </Tip>
    </div>
  );
}

// ── Editors ───────────────────────────────────────────────────────────

type Run = (action: () => Promise<unknown>) => Promise<boolean>;

function Editor({
  catalog,
  selection,
  settings,
  run,
  onToggle,
  onSelect
}: {
  catalog: Catalog;
  selection: Selection;
  settings: SettingsConnection;
  run: Run;
  onToggle: (kind: ItemKind, name: string, enabled: boolean) => void;
  onSelect: (s: Selection) => void;
}) {
  const canEdit = useContext(CanEdit);
  // Bumped on "Reset to default" so the editor reloads the restored content;
  // saves keep the draft (it already matches) so the "Saved" status shows.
  const [resets, setResets] = useState(0);
  const [newName, setNewName] = useState("");
  const { kind, name } = selection;

  if (selection.isNew && kind !== "plugin" && kind !== "tool") {
    const create = async (fields: Record<string, unknown>) => {
      const created = newName.trim();
      const ok = await run(() => settings.stub.create(kind, created, fields));
      if (ok) onSelect({ kind, name: created });
      return ok;
    };
    return (
      <div className="max-w-3xl space-y-4">
        <div>
          <h3 className="text-base font-semibold text-kumo-default">
            New {KIND_LABEL[kind]}
          </h3>
          <Text size="xs" variant="secondary">
            Created in the Custom plugin; available immediately after saving.
          </Text>
        </div>
        <Field
          label="Name"
          hint={`Lowercase letters, numbers and dashes${kind === "skill" ? "" : `; used as /${newName || "name"}`}.`}
        >
          <TextInput
            value={newName}
            onChange={(v) => setNewName(v.toLowerCase())}
            ariaLabel="Name"
          />
        </Field>
        {kind === "skill" && (
          <SkillEditor skill={NEW_ITEM.skill} onSave={create} />
        )}
        {kind === "prompt" && (
          <PromptEditor prompt={NEW_ITEM.prompt} onSave={create} />
        )}
        {kind === "workflow" && (
          <WorkflowEditor
            workflow={NEW_ITEM.workflow}
            catalog={catalog}
            onSave={create}
          />
        )}
      </div>
    );
  }
  const plugin = catalog.find(
    (p) => (kind === "plugin" ? p.id === name : true) && findItem(p, kind, name)
  );
  const item = plugin && findItem(plugin, kind, name);
  if (!plugin || !item)
    return <Text variant="secondary">Select a plugin or item.</Text>;

  const header = (title: string, subtitle: string) => (
    <div className="flex items-start justify-between gap-3 mb-4">
      <div>
        <h3 className="text-base font-semibold text-kumo-default font-mono">
          {title}
        </h3>
        <Text size="xs" variant="secondary">
          {subtitle}
        </Text>
      </div>
      <div className="flex items-center gap-2">
        {"modified" in item && item.modified === true && (
          <Badge variant="secondary">Edited</Badge>
        )}
        <Tip
          content={
            canEdit
              ? item.enabled
                ? "Turn this off"
                : "Turn this on"
              : "Read-only: unlock editing with the admin key"
          }
        >
          <Switch
            checked={item.enabled}
            disabled={!canEdit || (kind !== "plugin" && !plugin.enabled)}
            onCheckedChange={(on) => onToggle(kind, name, on)}
            aria-label={item.enabled ? "Disable" : "Enable"}
          />
        </Tip>
      </div>
    </div>
  );

  if (kind === "plugin") {
    const counts = SECTIONS.map(
      ({ key, label }) => `${plugin[key].length} ${label.toLowerCase()}`
    ).join(" · ");
    return (
      <div className="max-w-3xl">
        {header(plugin.name, `Plugin ${plugin.id} · v${plugin.version}`)}
        <Text>{plugin.description}</Text>
        <Text size="sm" variant="secondary">
          {counts}
        </Text>
        {!plugin.enabled && (
          <Notice>
            This plugin is disabled, so none of its skills, commands, workflows
            or tools are available.
          </Notice>
        )}
      </div>
    );
  }

  if (kind === "tool") {
    const tool = plugin.tools.find((t) => t.name === name)!;
    return (
      <div className="max-w-3xl space-y-3">
        {header(tool.name, `Tool · plugin ${plugin.id}`)}
        <Text>{tool.description}</Text>
        {tool.needsApproval && (
          <Notice>
            Calls require the user's approval in chat, so workflow steps can't
            use this tool.
          </Notice>
        )}
        <Text size="xs" variant="secondary">
          Tools are code (plugins/{plugin.id}/tools/{tool.name}.ts); Settings
          can enable or disable them.
        </Text>
      </div>
    );
  }

  const editable = kind as EditableKind;
  const save = (fields: Record<string, unknown>) =>
    run(() => settings.stub.update(editable, name, fields));
  const reset = async () => {
    const ok = await run(() => settings.stub.reset(editable, name));
    if (ok) setResets((n) => n + 1);
    return ok;
  };
  const isCustom = "custom" in item && item.custom === true;
  const remove = async () => {
    const ok = await run(() => settings.stub.remove(editable, name));
    if (ok) onSelect({ kind: "plugin", name: CUSTOM_PLUGIN.id });
    return ok;
  };
  // Custom items have no default to reset to; they can be deleted instead.
  const actions = isCustom ? { onDelete: remove } : { onReset: reset };
  const shadowedBy =
    "shadowedBy" in item && typeof item.shadowedBy === "string"
      ? item.shadowedBy
      : undefined;
  const subtitle = `${kind === "prompt" ? "Command" : kind[0].toUpperCase() + kind.slice(1)} · plugin ${plugin.id}`;
  const contentKey = `${kind}:${name}:${resets}`;

  return (
    <div className="max-w-3xl">
      {header(kind === "skill" ? name : `/${name}`, subtitle)}
      {shadowedBy && (
        <Notice>
          The {shadowedBy} plugin now defines "{name}", so this custom{" "}
          {KIND_LABEL[editable]} is inactive. Recreate it under a new name, then
          delete this one.
        </Notice>
      )}
      {kind === "skill" && (
        <SkillEditor
          key={contentKey}
          skill={plugin.skills.find((s) => s.name === name)!}
          onSave={save}
          {...actions}
        />
      )}
      {kind === "prompt" && (
        <PromptEditor
          key={contentKey}
          prompt={plugin.prompts.find((p) => p.name === name)!}
          onSave={save}
          {...actions}
        />
      )}
      {kind === "workflow" && (
        <WorkflowEditor
          key={contentKey}
          workflow={plugin.workflows.find((w) => w.name === name)!}
          catalog={catalog}
          onSave={save}
          {...actions}
        />
      )}
    </div>
  );
}

function findItem(plugin: EffectivePlugin, kind: ItemKind, name: string) {
  if (kind === "plugin") return plugin.id === name ? plugin : undefined;
  return (plugin[`${kind}s`] as { name: string; enabled: boolean }[]).find(
    (i) => i.name === name
  );
}

interface EditorProps {
  onSave: (fields: Record<string, unknown>) => Promise<boolean>;
  /** Restore the bundled default (bundled items). */
  onReset?: () => Promise<boolean>;
  /** Delete the item (custom items). */
  onDelete?: () => Promise<boolean>;
}

function SkillEditor({
  skill,
  onSave,
  ...actions
}: EditorProps & {
  skill: Pick<SkillInfo, "description" | "always" | "body"> & {
    modified: boolean;
  };
}) {
  const [draft, setDraft] = useState({
    description: skill.description,
    always: skill.always,
    body: skill.body
  });
  return (
    <Form onSave={() => onSave(draft)} {...actions} modified={skill.modified}>
      <Field
        label="Description"
        hint="Shown to the agent in the skills directory; say when to use it."
      >
        <TextInput
          value={draft.description}
          onChange={(description) => setDraft({ ...draft, description })}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm text-kumo-default">
        <input
          type="checkbox"
          checked={draft.always}
          onChange={(e) => setDraft({ ...draft, always: e.target.checked })}
        />
        Always on (included in every system prompt; otherwise loaded on demand)
      </label>
      <Field label="Instructions">
        <TextArea
          rows={16}
          value={draft.body}
          onChange={(body) => setDraft({ ...draft, body })}
        />
      </Field>
    </Form>
  );
}

function PromptEditor({
  prompt,
  onSave,
  ...actions
}: EditorProps & {
  prompt: Pick<PromptInfo, "description" | "argumentHint" | "body"> & {
    modified: boolean;
  };
}) {
  const [draft, setDraft] = useState({
    description: prompt.description,
    argumentHint: prompt.argumentHint ?? "",
    body: prompt.body
  });
  return (
    <Form onSave={() => onSave(draft)} {...actions} modified={prompt.modified}>
      <Field label="Description" hint="Shown in the / command menu.">
        <TextInput
          value={draft.description}
          onChange={(description) => setDraft({ ...draft, description })}
        />
      </Field>
      <Field
        label="Argument hint"
        hint='Shown after the command, e.g. "<meeting notes>". Leave empty if it takes no arguments.'
      >
        <TextInput
          value={draft.argumentHint}
          onChange={(argumentHint) => setDraft({ ...draft, argumentHint })}
        />
      </Field>
      <Field
        label="Prompt"
        hint="$ARGUMENTS is replaced with what the user types after the command."
      >
        <TextArea
          rows={12}
          value={draft.body}
          onChange={(body) => setDraft({ ...draft, body })}
        />
      </Field>
    </Form>
  );
}

function WorkflowEditor({
  workflow,
  catalog,
  onSave,
  ...actions
}: EditorProps & {
  workflow: Pick<WorkflowInfo, "description" | "argumentHint" | "steps"> & {
    problems: string[];
    modified: boolean;
  };
  catalog: Catalog;
}) {
  const [draft, setDraft] = useState({
    description: workflow.description,
    argumentHint: workflow.argumentHint ?? "",
    steps: workflow.steps
  });
  const skills = catalog.flatMap((p) => p.skills);
  const tools = catalog.flatMap((p) => p.tools);

  const setStep = (index: number, patch: Partial<WorkflowStep>) =>
    setDraft({
      ...draft,
      steps: draft.steps.map((s, i) => (i === index ? { ...s, ...patch } : s))
    });
  const moveStep = (index: number, delta: number) => {
    const steps = [...draft.steps];
    const [step] = steps.splice(index, 1);
    steps.splice(index + delta, 0, step);
    setDraft({ ...draft, steps });
  };

  return (
    <Form
      onSave={() => onSave(draft)}
      {...actions}
      modified={workflow.modified}
    >
      {workflow.problems.length > 0 && (
        <Notice>
          This workflow can't run as configured:
          <ul className="list-disc ml-5 mt-1">
            {workflow.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Notice>
      )}
      <Field label="Description" hint="Shown in the / command menu.">
        <TextInput
          value={draft.description}
          onChange={(description) => setDraft({ ...draft, description })}
        />
      </Field>
      <Field
        label="Argument hint"
        hint="Optional; the arguments fill $ARGUMENTS in step prompts."
      >
        <TextInput
          value={draft.argumentHint}
          onChange={(argumentHint) => setDraft({ ...draft, argumentHint })}
        />
      </Field>

      <div className="space-y-3">
        <Text size="sm" bold>
          Steps
        </Text>
        {draft.steps.map((step, i) => (
          <div
            key={i}
            className="rounded-xl ring ring-kumo-line bg-kumo-base p-4 space-y-3"
          >
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-kumo-subtle">
                {i + 1}.
              </span>
              <div className="flex-1">
                <TextInput
                  value={step.name}
                  onChange={(name) => setStep(i, { name })}
                  ariaLabel={`Step ${i + 1} name`}
                />
              </div>
              <Tip content="Move this step earlier">
                <Button
                  variant="ghost"
                  shape="square"
                  size="sm"
                  aria-label="Move step up"
                  disabled={i === 0}
                  icon={<ArrowUpIcon size={14} />}
                  onClick={() => moveStep(i, -1)}
                />
              </Tip>
              <Tip content="Move this step later">
                <Button
                  variant="ghost"
                  shape="square"
                  size="sm"
                  aria-label="Move step down"
                  disabled={i === draft.steps.length - 1}
                  icon={<ArrowDownIcon size={14} />}
                  onClick={() => moveStep(i, 1)}
                />
              </Tip>
              <Tip content="Remove this step (a workflow needs at least one)">
                <Button
                  variant="ghost"
                  shape="square"
                  size="sm"
                  aria-label="Remove step"
                  disabled={draft.steps.length === 1}
                  icon={<TrashIcon size={14} />}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      steps: draft.steps.filter((_, j) => j !== i)
                    })
                  }
                />
              </Tip>
            </div>
            <Field label="Skill">
              <select
                value={step.skill ?? ""}
                onChange={(e) =>
                  setStep(i, { skill: e.target.value || undefined })
                }
                className="w-full px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default"
              >
                <option value="">None</option>
                {skills.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                    {s.enabled ? "" : " (disabled)"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tools this step may use">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {tools.map((t) => (
                  <label
                    key={t.name}
                    className={`flex items-center gap-1.5 text-sm font-mono ${t.needsApproval ? "text-kumo-subtle" : "text-kumo-default"}`}
                  >
                    <input
                      type="checkbox"
                      disabled={t.needsApproval}
                      checked={step.tools.includes(t.name)}
                      onChange={(e) =>
                        setStep(i, {
                          tools: e.target.checked
                            ? [...step.tools, t.name]
                            : step.tools.filter((n) => n !== t.name)
                        })
                      }
                    />
                    {t.name}
                    {t.needsApproval && (
                      <span className="font-sans text-xs">
                        (needs approval)
                      </span>
                    )}
                    {!t.enabled && !t.needsApproval && (
                      <span className="font-sans text-xs text-kumo-subtle">
                        (disabled)
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Instruction">
              <TextArea
                rows={4}
                value={step.prompt}
                onChange={(prompt) => setStep(i, { prompt })}
              />
            </Field>
          </div>
        ))}
        <Tip content="Add a step at the end (up to 10)">
          <Button
            variant="secondary"
            size="sm"
            icon={<PlusIcon size={14} />}
            disabled={draft.steps.length >= 10}
            onClick={() =>
              setDraft({
                ...draft,
                steps: [
                  ...draft.steps,
                  {
                    name: `Step ${draft.steps.length + 1}`,
                    prompt: "",
                    tools: []
                  }
                ]
              })
            }
          >
            Add step
          </Button>
        </Tip>
      </div>
    </Form>
  );
}

// ── Form primitives ───────────────────────────────────────────────────

function Form({
  children,
  modified,
  onSave,
  onReset,
  onDelete
}: {
  children: React.ReactNode;
  modified: boolean;
  onSave: () => Promise<boolean>;
  onReset?: () => Promise<boolean>;
  onDelete?: () => Promise<boolean>;
}) {
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const canEdit = useContext(CanEdit);
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setStatus("saving");
        setStatus((await onSave()) ? "saved" : "idle");
      }}
    >
      {children}
      <div className="flex items-center gap-2 pt-2">
        <Tip
          content={
            canEdit
              ? "Save; applies to new messages immediately"
              : "Read-only: unlock editing with the admin key"
          }
        >
          <Button
            type="submit"
            variant="primary"
            disabled={!canEdit || status === "saving"}
          >
            {status === "saving" ? "Saving…" : "Save"}
          </Button>
        </Tip>
        {onReset && (
          <Tip
            content={
              canEdit
                ? "Discard your edits and restore the plugin's version"
                : "Read-only: unlock editing with the admin key"
            }
          >
            <Button
              type="button"
              variant="secondary"
              disabled={!canEdit || !modified}
              icon={<ArrowCounterClockwiseIcon size={14} />}
              onClick={() => {
                if (
                  confirm(
                    "Discard your edits and restore the plugin's default?"
                  )
                )
                  onReset();
              }}
            >
              Reset to default
            </Button>
          </Tip>
        )}
        {onDelete && (
          <Tip
            content={
              canEdit
                ? "Permanently delete this item you created"
                : "Read-only: unlock editing with the admin key"
            }
          >
            <Button
              type="button"
              variant="secondary"
              disabled={!canEdit}
              icon={<TrashIcon size={14} />}
              onClick={() => {
                if (confirm("Delete this item? This can't be undone."))
                  onDelete();
              }}
            >
              Delete
            </Button>
          </Tip>
        )}
        {status === "saved" && (
          <Text size="xs" variant="secondary">
            Saved
          </Text>
        )}
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Text size="sm" bold>
        {label}
      </Text>
      {children}
      {hint && (
        <Text size="xs" variant="secondary">
          {hint}
        </Text>
      )}
    </div>
  );
}

const INPUT_CLASS =
  "w-full px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-ring";

function TextInput({
  value,
  onChange,
  ariaLabel
}: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel?: string;
}) {
  return (
    <input
      aria-label={ariaLabel}
      className={INPUT_CLASS}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function TextArea({
  value,
  onChange,
  rows
}: {
  value: string;
  onChange: (v: string) => void;
  rows: number;
}) {
  return (
    <textarea
      rows={rows}
      className={`${INPUT_CLASS} font-mono leading-relaxed`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 rounded-lg px-3 py-2 text-sm bg-amber-500/10 text-amber-800 dark:text-amber-300 ring-1 ring-amber-500/30">
      {children}
    </div>
  );
}
