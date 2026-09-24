import { Agent, callable, getAgentByName } from "agents";
import {
  EMPTY_OVERRIDES,
  itemKey,
  OverridesSchema,
  resolveCatalog,
  SETTINGS_NAME,
  type Catalog,
  type ItemKind,
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
 */
export class SettingsAgent extends Agent<Env, Overrides> {
  initialState = EMPTY_OVERRIDES;

  /** Bundled plugins with overrides applied. */
  catalog(): Catalog {
    return resolveCatalog(BUNDLED_PLUGINS, this.state);
  }

  @callable()
  setEnabled(kind: ItemKind, name: string, enabled: boolean) {
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
    this.assertExists(kind, name);
    const next = structuredClone(this.state);
    next.disabled = next.disabled.filter((k) => k !== itemKey(kind, name));
    if (kind in OVERRIDE_FIELD)
      delete next[OVERRIDE_FIELD[kind as EditableKind]][name];
    this.setState(next);
  }

  @callable()
  resetAll() {
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
