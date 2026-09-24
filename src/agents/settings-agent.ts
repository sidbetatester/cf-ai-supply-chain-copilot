import { Agent, callable, getAgentByName, getCurrentAgent } from "agents";
import {
  EMPTY_OVERRIDES,
  itemKey,
  KEBAB_NAME,
  normalizeOverrides,
  OverridesSchema,
  resolveCatalog,
  SETTINGS_NAME,
  type Catalog,
  type ItemKind,
  type SettingsAccess,
  type Overrides
} from "../plugins/catalog";
import { BUNDLED_PLUGINS } from "../plugins/registry";
import {
  denySubAgents,
  isAdminKey,
  rejectClientStateChange,
  withinRateLimit
} from "./guards";

/** The effective plugin catalog (bundled plugins + Settings), read over RPC. */
export async function getCatalog(env: Env): Promise<Catalog> {
  const settings = await getAgentByName(env.SettingsAgent, SETTINGS_NAME);
  return (await settings.catalog()) as Catalog;
}

type EditableKind = "skill" | "prompt" | "workflow";

/** Validate overrides with the plugin content schemas; throws (rejecting the UI call) when invalid. */
function parseOverrides(value: unknown): Overrides {
  const result = OverridesSchema.safeParse(value);
  if (!result.success) {
    // Paths look like ["skills", "<name>", "body"] or ["custom", "skills", "<name>", ...];
    // report the field (or the name itself), not the map keys.
    const field = (path: PropertyKey[]) => {
      const rest = path.slice(path[0] === "custom" ? 3 : 2);
      return rest.length > 0
        ? rest.join(".")
        : path[0] === "custom"
          ? "name"
          : "value";
    };
    throw new Error(
      result.error.issues
        .map((i) => `${field(i.path)}: ${i.message}`)
        .join("; ")
    );
  }
  return result.data;
}

/** Per-connection flags (survive hibernation). */
interface EditorConnectionState {
  /** Set by a successful unlock(). */
  settingsEditor?: boolean;
  /** Failed unlock attempts on this connection. */
  unlockFailures?: number;
}

/** Wrong keys allowed per connection before it must reconnect. */
const MAX_UNLOCK_FAILURES = 5;
const OVERRIDE_FIELD = {
  skill: "skills",
  prompt: "prompts",
  workflow: "workflows"
} as const;

/**
 * Stores Settings as overrides on top of the bundled plugins: disabled items
 * and edited skill, prompt and workflow content. Edits are validated with the
 * same schemas as plugin files; state syncs live to the Settings UI, and
 * agents read the effective catalog over RPC on every turn.
 *
 * Settings are read-only for everyone. A connection may edit only after
 * unlock() with the SETTINGS_ADMIN_KEY secret; without the secret, editing is
 * disabled entirely.
 */
export class SettingsAgent extends Agent<Env, Overrides> {
  initialState = EMPTY_OVERRIDES;

  // ── Security: state changes are server-only; no sub-agent routes ───

  validateStateChange(_next: unknown, source: unknown) {
    rejectClientStateChange(source);
  }

  onBeforeSubAgent() {
    return denySubAgents();
  }

  /** Stored overrides in the current shape (state saved by older versions lacks newer fields). */
  private get overrides(): Overrides {
    return normalizeOverrides(this.state);
  }

  /** Bundled plugins with overrides applied. */
  catalog(): Catalog {
    return resolveCatalog(BUNDLED_PLUGINS, this.overrides);
  }

  // ── Access ────────────────────────────────────────────────────────

  @callable()
  access(): SettingsAccess {
    return {
      configured: !!this.env.SETTINGS_ADMIN_KEY,
      unlocked: this.isEditor()
    };
  }

  /** Allow the calling connection to edit Settings if the admin key matches. */
  @callable()
  async unlock(key: string): Promise<SettingsAccess> {
    if (!this.env.SETTINGS_ADMIN_KEY)
      throw new Error(
        "Editing is disabled: no admin key is configured for this deployment."
      );
    const { connection } = getCurrentAgent();
    const state = (connection?.state ?? {}) as EditorConnectionState;
    // Throttle guessing: per connection, and across all connections.
    if ((state.unlockFailures ?? 0) >= MAX_UNLOCK_FAILURES)
      throw new Error("Too many attempts. Reload the page to try again.");
    if (
      !(await withinRateLimit(this.env.UNLOCK_RATE_LIMITER, "settings-unlock"))
    )
      throw new Error("Too many attempts. Wait a minute and try again.");

    if (!(await isAdminKey(this.env, key))) {
      connection?.setState((prev: EditorConnectionState | null) => ({
        ...prev,
        unlockFailures: (prev?.unlockFailures ?? 0) + 1
      }));
      throw new Error("That admin key isn't correct.");
    }
    connection?.setState((prev: EditorConnectionState | null) => ({
      ...prev,
      settingsEditor: true,
      unlockFailures: 0
    }));
    return this.access();
  }

  private isEditor() {
    const state = getCurrentAgent().connection?.state as
      | EditorConnectionState
      | null
      | undefined;
    return !!this.env.SETTINGS_ADMIN_KEY && state?.settingsEditor === true;
  }

  private requireEditor() {
    if (!this.isEditor())
      throw new Error(
        "Settings are read-only. Unlock editing with the admin key."
      );
  }

  // ── Edits (require an unlocked connection) ────────────────────────

  @callable()
  setEnabled(kind: ItemKind, name: string, enabled: boolean) {
    this.requireEditor();
    this.findItem(kind, name);
    const key = itemKey(kind, name);
    const disabled = this.overrides.disabled.filter((k) => k !== key);
    this.setState({
      ...this.overrides,
      disabled: enabled ? disabled : [...disabled, key]
    });
  }

  /** Create a skill, command or workflow in the Custom plugin. */
  @callable()
  create(kind: EditableKind, name: string, fields: Record<string, unknown>) {
    this.requireEditor();
    if (typeof name !== "string" || !KEBAB_NAME.test(name) || name.length > 64)
      throw new Error(
        "Name must be lowercase letters, numbers and dashes, e.g. supplier-escalation"
      );
    const clash = this.nameOwner(kind, name);
    if (clash)
      throw new Error(`"${name}" is already used by the ${clash} plugin`);
    this.saveValidated(kind, name, this.withCustom(kind, name, fields));
  }

  /**
   * Save edits: a custom item's full definition, or the override for a bundled
   * item (fields not given keep the bundled value).
   */
  @callable()
  update(kind: EditableKind, name: string, fields: Record<string, unknown>) {
    this.requireEditor();
    const item = this.findItem(kind, name);
    const field = OVERRIDE_FIELD[kind];
    this.saveValidated(
      kind,
      name,
      item.custom
        ? this.withCustom(kind, name, fields)
        : {
            ...this.overrides,
            [field]: { ...this.overrides[field], [name]: fields }
          }
    );
  }

  /** Delete an item created in Settings. */
  @callable()
  remove(kind: EditableKind, name: string) {
    this.requireEditor();
    if (!this.findItem(kind, name).custom) {
      throw new Error(
        "Only items created in Settings can be deleted; disable plugin items instead."
      );
    }
    const next = structuredClone(this.overrides);
    delete next.custom[OVERRIDE_FIELD[kind]][name];
    next.disabled = next.disabled.filter((k) => k !== itemKey(kind, name));
    this.setState(next);
  }

  /** Re-enable an item and drop its edits (custom items keep their definition). */
  @callable()
  reset(kind: ItemKind, name: string) {
    this.requireEditor();
    this.findItem(kind, name);
    const next = structuredClone(this.overrides);
    next.disabled = next.disabled.filter((k) => k !== itemKey(kind, name));
    if (kind in OVERRIDE_FIELD)
      delete next[OVERRIDE_FIELD[kind as EditableKind]][name];
    this.setState(next);
  }
  @callable()
  resetAll() {
    this.requireEditor();
    this.setState(EMPTY_OVERRIDES);
  }

  /** Validate candidate overrides (schemas, then workflow references) and persist. */
  private saveValidated(kind: EditableKind, name: string, candidate: unknown) {
    const next = parseOverrides(candidate);
    if (kind === "workflow") {
      const workflow = resolveCatalog(BUNDLED_PLUGINS, next)
        .flatMap((p) => p.workflows)
        .find((w) => w.name === name);
      if (workflow?.problems.length)
        throw new Error(workflow.problems.join("; "));
    }
    this.setState(next);
  }

  private withCustom(
    kind: EditableKind,
    name: string,
    fields: Record<string, unknown>
  ) {
    const field = OVERRIDE_FIELD[kind];
    const custom = this.overrides.custom;
    return {
      ...this.overrides,
      custom: { ...custom, [field]: { ...custom[field], [name]: fields } }
    };
  }

  /** An item (bundled or custom) in the effective catalog; throws if unknown. */
  private findItem(kind: ItemKind, name: string) {
    const catalog = this.catalog();
    const item =
      kind === "plugin"
        ? catalog.find((p) => p.id === name) && { custom: false }
        : catalog
            .flatMap(
              (p) => p[`${kind}s`] as { name: string; custom: boolean }[]
            )
            .find((i) => i.name === name);
    if (!item) throw new Error(`Unknown ${kind} "${name}"`);
    return item;
  }

  /** The plugin already using `name` in the kind's namespace (skills; or commands = prompts + workflows). */
  private nameOwner(kind: EditableKind, name: string) {
    for (const p of this.catalog()) {
      const items =
        kind === "skill" ? p.skills : [...p.prompts, ...p.workflows];
      if (items.some((i) => i.name === name)) return p.name;
    }
    return undefined;
  }
}
