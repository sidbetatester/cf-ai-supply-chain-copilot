import { timingSafeEqual } from "node:crypto";
import { Agent, callable, getAgentByName, getCurrentAgent } from "agents";
import {
  EMPTY_OVERRIDES,
  itemKey,
  OverridesSchema,
  resolveCatalog,
  SETTINGS_NAME,
  type Catalog,
  type ItemKind,
  type SettingsAccess,
  type Overrides
} from "../plugins/catalog";
import { BUNDLED_PLUGINS } from "../plugins/registry";

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
    // Paths look like ["skills", "<name>", "body"]; report the field, not the map key.
    throw new Error(
      result.error.issues
        .map((i) => `${i.path.slice(2).join(".") || "value"}: ${i.message}`)
        .join("; ")
    );
  }
  return result.data;
}

/** Per-connection flag set by a successful unlock(); survives hibernation. */
interface EditorConnectionState {
  settingsEditor?: boolean;
}

const sha256 = async (text: string) =>
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  );

/** Constant-time comparison (hashing first gives equal-length inputs). */
async function keysMatch(given: string, expected: string) {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  return timingSafeEqual(a, b);
}

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

  /** Bundled plugins with overrides applied. */
  catalog(): Catalog {
    return resolveCatalog(BUNDLED_PLUGINS, this.state);
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
    const expected = this.env.SETTINGS_ADMIN_KEY;
    if (!expected)
      throw new Error(
        "Editing is disabled: no admin key is configured for this deployment."
      );
    if (typeof key !== "string" || !(await keysMatch(key, expected))) {
      throw new Error("That admin key isn't correct.");
    }
    const { connection } = getCurrentAgent();
    connection?.setState((prev: EditorConnectionState | null) => ({
      ...prev,
      settingsEditor: true
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
    this.assertExists(kind, name);
    const key = itemKey(kind, name);
    const disabled = this.state.disabled.filter((k) => k !== key);
    this.setState({
      ...this.state,
      disabled: enabled ? disabled : [...disabled, key]
    });
  }

  /** Replace the override for a skill, prompt or workflow (fields not given keep the bundled value). */
  @callable()
  update(kind: EditableKind, name: string, fields: Record<string, unknown>) {
    this.requireEditor();
    this.assertExists(kind, name);
    const field = OVERRIDE_FIELD[kind];
    const next = parseOverrides({
      ...this.state,
      [field]: { ...this.state[field], [name]: fields }
    });
    if (kind === "workflow") {
      const workflow = resolveCatalog(BUNDLED_PLUGINS, next)
        .flatMap((p) => p.workflows)
        .find((w) => w.name === name);
      if (workflow?.problems.length)
        throw new Error(workflow.problems.join("; "));
    }
    this.setState(next);
  }

  /** Drop all edits for one item and re-enable it. */
  @callable()
  reset(kind: ItemKind, name: string) {
    this.requireEditor();
    this.assertExists(kind, name);
    const next = structuredClone(this.state);
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

  private assertExists(kind: ItemKind, name: string) {
    const exists = BUNDLED_PLUGINS.some((p) =>
      kind === "plugin"
        ? p.id === name
        : p[`${kind}s` as "skills" | "prompts" | "tools" | "workflows"].some(
            (i) => i.name === name
          )
    );
    if (!exists) throw new Error(`Unknown ${kind} "${name}"`);
  }
}
