// Plugin content schemas, catalog types, and the effective catalog: bundled
// plugin content with user overrides (Settings) applied. Pure and free of
// bundling globs, so the server and the Settings UI share one resolver.
import { z } from "zod";

// ── Content schemas (plugin files and Settings edits) ─────────────────

export const PluginManifestSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "Expected semver, e.g. 1.0.0")
});

export const SkillMetaSchema = z.object({
  description: z.string().min(1),
  /** Always included in the system prompt; otherwise loaded on demand via useSkill. */
  always: z.boolean().default(false)
});

export const PromptMetaSchema = z.object({
  description: z.string().min(1),
  /** Placeholder shown after the /command, e.g. "<meeting notes>". */
  argumentHint: z.string().optional()
});

export const WorkflowStepSchema = z.object({
  name: z.string().min(1),
  /** Instruction for this step; $ARGUMENTS is replaced with the command arguments. */
  prompt: z.string().min(1),
  /** Skill whose instructions are loaded for this step. */
  skill: z.string().optional(),
  /** Tools this step may call (none by default). */
  tools: z.array(z.string()).default([])
});

export const WorkflowSchema = z.object({
  description: z.string().min(1),
  argumentHint: z.string().optional(),
  steps: z.array(WorkflowStepSchema).min(1).max(10)
});

const body = z.string().trim().min(1);

/** User edits layered over bundled plugins. Absent fields keep the bundled value. */
export const OverridesSchema = z.object({
  /** Disabled items as "<kind>:<name>" keys (see itemKey). */
  disabled: z.array(z.string()).default([]),
  skills: z
    .record(
      z.string(),
      SkillMetaSchema.partial().extend({ body: body.optional() })
    )
    .default({}),
  prompts: z
    .record(
      z.string(),
      PromptMetaSchema.partial().extend({ body: body.optional() })
    )
    .default({}),
  workflows: z.record(z.string(), WorkflowSchema.partial()).default({})
});

export type Overrides = z.infer<typeof OverridesSchema>;
export const EMPTY_OVERRIDES: Overrides = {
  disabled: [],
  skills: {},
  prompts: {},
  workflows: {}
};

/** Name of the single SettingsAgent instance that stores Overrides. */
export const SETTINGS_NAME = "global";

/** Whether this deployment allows Settings edits, and whether this connection may make them. */
export interface SettingsAccess {
  configured: boolean;
  unlocked: boolean;
}

export type ItemKind = "plugin" | "skill" | "tool" | "prompt" | "workflow";
export const itemKey = (kind: ItemKind, name: string) => `${kind}:${name}`;

// ── Catalog types (serializable; shared with the UI) ──────────────────

export interface SkillInfo {
  name: string;
  plugin: string;
  description: string;
  always: boolean;
  body: string;
}

export interface PromptInfo {
  name: string;
  plugin: string;
  description: string;
  argumentHint?: string;
  body: string;
}

export interface ToolInfo {
  name: string;
  plugin: string;
  description: string;
  /** Calls need the user's approval, so workflow steps (unattended) can't use it. */
  needsApproval: boolean;
}

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export interface WorkflowInfo {
  name: string;
  plugin: string;
  description: string;
  argumentHint?: string;
  steps: WorkflowStep[];
}

export interface PluginInfo extends z.infer<typeof PluginManifestSchema> {
  id: string;
  skills: SkillInfo[];
  prompts: PromptInfo[];
  tools: ToolInfo[];
  workflows: WorkflowInfo[];
}

/** An item as the app sees it: overrides applied, plus its Settings status. */
export type Effective<T> = T & {
  /** Usable: neither the item nor its plugin is disabled. */
  enabled: boolean;
  /** Differs from the bundled plugin file. */
  modified: boolean;
};

export type EffectiveWorkflow = Effective<WorkflowInfo> & {
  /** Why the workflow can't run as configured (e.g. a step's tool is disabled). */
  problems: string[];
};

export interface EffectivePlugin extends Omit<
  PluginInfo,
  "skills" | "prompts" | "tools" | "workflows"
> {
  enabled: boolean;
  skills: Effective<SkillInfo>[];
  prompts: Effective<PromptInfo>[];
  tools: Effective<ToolInfo>[];
  workflows: EffectiveWorkflow[];
}

export type Catalog = EffectivePlugin[];

/** Anything runnable as a /command: an enabled prompt, or an enabled workflow that can run. */
export interface CommandInfo {
  name: string;
  plugin: string;
  description: string;
  argumentHint?: string;
  kind: "prompt" | "workflow";
}

// ── Validation ────────────────────────────────────────────────────────

/**
 * Steps may only use existing skills, and tools that need no approval (steps
 * run unattended). Returns human-readable problems; empty means valid.
 */
export function workflowProblems(
  steps: WorkflowStep[],
  /** Skill name → enabled. */
  skills: ReadonlyMap<string, boolean>,
  /** Tool name → status. */
  tools: ReadonlyMap<string, { enabled: boolean; needsApproval: boolean }>
): string[] {
  const problems: string[] = [];
  for (const step of steps) {
    if (step.skill) {
      const enabled = skills.get(step.skill);
      if (enabled === undefined)
        problems.push(`Step "${step.name}" uses unknown skill "${step.skill}"`);
      else if (!enabled)
        problems.push(
          `Step "${step.name}" uses disabled skill "${step.skill}"`
        );
    }
    for (const name of step.tools) {
      const tool = tools.get(name);
      if (!tool)
        problems.push(`Step "${step.name}" uses unknown tool "${name}"`);
      else if (tool.needsApproval)
        problems.push(
          `Step "${step.name}" can't use "${name}": it requires user approval`
        );
      else if (!tool.enabled)
        problems.push(`Step "${step.name}" uses disabled tool "${name}"`);
    }
  }
  return problems;
}

// ── Resolution ────────────────────────────────────────────────────────

const differs = (base: object, override: object | undefined) =>
  !!override &&
  Object.entries(override).some(
    ([k, v]) =>
      JSON.stringify(v) !== JSON.stringify((base as Record<string, unknown>)[k])
  );

/** Apply overrides to bundled plugins. Pure; the same result on server and client. */
export function resolveCatalog(
  bundled: PluginInfo[],
  overrides: Overrides
): Catalog {
  const disabled = new Set(overrides.disabled);
  const on = (pluginOn: boolean, kind: ItemKind, name: string) =>
    pluginOn && !disabled.has(itemKey(kind, name));

  const plugins: Catalog = bundled.map((p) => {
    const enabled = !disabled.has(itemKey("plugin", p.id));
    return {
      ...p,
      enabled,
      skills: p.skills.map((s) => {
        const o = overrides.skills[s.name];
        return {
          ...s,
          ...o,
          enabled: on(enabled, "skill", s.name),
          modified: differs(s, o)
        };
      }),
      prompts: p.prompts.map((s) => {
        const o = overrides.prompts[s.name];
        return {
          ...s,
          ...o,
          enabled: on(enabled, "prompt", s.name),
          modified: differs(s, o)
        };
      }),
      tools: p.tools.map((t) => ({
        ...t,
        enabled: on(enabled, "tool", t.name),
        modified: false
      })),
      workflows: p.workflows.map((w) => {
        const o = overrides.workflows[w.name];
        return {
          ...w,
          ...o,
          enabled: on(enabled, "workflow", w.name),
          modified: differs(w, o),
          problems: []
        };
      })
    };
  });

  const skills = new Map(
    plugins.flatMap((p) => p.skills.map((s) => [s.name, s.enabled] as const))
  );
  const tools = new Map(
    plugins.flatMap((p) => p.tools.map((t) => [t.name, t] as const))
  );
  for (const w of plugins.flatMap((p) => p.workflows)) {
    w.problems = workflowProblems(w.steps, skills, tools);
  }
  return plugins;
}

// ── Queries over the effective catalog ────────────────────────────────

export const activeSkills = (c: Catalog) =>
  c.flatMap((p) => p.skills).filter((s) => s.enabled);
export const activePrompts = (c: Catalog) =>
  c.flatMap((p) => p.prompts).filter((s) => s.enabled);
export const activeTools = (c: Catalog) =>
  c.flatMap((p) => p.tools).filter((t) => t.enabled);
/** Enabled workflows that can run as configured. */
export const activeWorkflows = (c: Catalog) =>
  c
    .flatMap((p) => p.workflows)
    .filter((w) => w.enabled && w.problems.length === 0);

export const listCommands = (c: Catalog): CommandInfo[] => [
  ...activePrompts(c).map(({ name, plugin, description, argumentHint }) => ({
    name,
    plugin,
    description,
    argumentHint,
    kind: "prompt" as const
  })),
  ...activeWorkflows(c).map(({ name, plugin, description, argumentHint }) => ({
    name,
    plugin,
    description,
    argumentHint,
    kind: "workflow" as const
  }))
];
