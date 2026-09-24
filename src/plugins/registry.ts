// Discovers and validates plugins/<plugin>/{plugin.json,skills,prompts,tools,workflows}.
// Everything is bundled at build time (Workers have no runtime filesystem);
// invalid or conflicting plugin content fails fast, naming the file.
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { parseMarkdown, validate } from "../validate";
import type { ToolDefinition } from "./define";

const MANIFEST_FILES = import.meta.glob<unknown>(
  "../../plugins/*/plugin.json",
  {
    import: "default",
    eager: true
  }
);
const SKILL_FILES = import.meta.glob<string>("../../plugins/*/skills/*.md", {
  query: "?raw",
  import: "default",
  eager: true
});
const PROMPT_FILES = import.meta.glob<string>("../../plugins/*/prompts/*.md", {
  query: "?raw",
  import: "default",
  eager: true
});
const WORKFLOW_FILES = import.meta.glob<string>(
  "../../plugins/*/workflows/*.yaml",
  { query: "?raw", import: "default", eager: true }
);
const TOOL_FILES = import.meta.glob<{ default?: ToolDefinition }>(
  "../../plugins/*/tools/*.ts",
  {
    eager: true
  }
);

// ── Content schemas ───────────────────────────────────────────────────

const PluginManifestSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "Expected semver, e.g. 1.0.0")
});

const SkillMetaSchema = z.object({
  description: z.string().min(1),
  /** Always included in the system prompt; otherwise loaded on demand via useSkill. */
  always: z.boolean().default(false)
});

const PromptMetaSchema = z.object({
  description: z.string().min(1),
  /** Placeholder shown after the /command, e.g. "<meeting notes>". */
  argumentHint: z.string().optional()
});

const WorkflowStepSchema = z.object({
  name: z.string().min(1),
  /** Instruction for this step; $ARGUMENTS is replaced with the command arguments. */
  prompt: z.string().min(1),
  /** Skill whose instructions are loaded for this step. */
  skill: z.string().optional(),
  /** Tools this step may call (none by default). */
  tools: z.array(z.string()).default([])
});

const WorkflowSchema = z.object({
  description: z.string().min(1),
  argumentHint: z.string().optional(),
  steps: z.array(WorkflowStepSchema).min(1).max(10)
});

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
}

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export interface WorkflowInfo {
  name: string;
  plugin: string;
  description: string;
  argumentHint?: string;
  steps: WorkflowStep[];
}

/** Anything runnable as a /command: a prompt or a workflow. */
export type CommandInfo = Pick<
  PromptInfo,
  "name" | "plugin" | "description" | "argumentHint"
> & {
  kind: "prompt" | "workflow";
};

export interface PluginInfo extends z.infer<typeof PluginManifestSchema> {
  id: string;
  skills: SkillInfo[];
  prompts: PromptInfo[];
  tools: ToolInfo[];
  workflows: WorkflowInfo[];
}

export type RegisteredTool = ToolDefinition & { name: string; plugin: string };

// ── Loading ───────────────────────────────────────────────────────────

const PATH_RE =
  /\/plugins\/([^/]+)\/(?:(skills|prompts|tools|workflows)\/)?([^/]+)\.(json|md|ts|yaml)$/;
const KEBAB = /^[a-z0-9][a-z0-9-]*$/;
const NAME_RULES = {
  skills: KEBAB,
  prompts: KEBAB,
  workflows: KEBAB,
  tools: /^[a-zA-Z][a-zA-Z0-9_]*$/
} as const;

function locate(path: string, kind: keyof typeof NAME_RULES) {
  const match = PATH_RE.exec(path);
  if (!match) throw new Error(`Unrecognized plugin file ${path}`);
  const [, plugin, , name, ext] = match;
  const file = `plugins/${plugin}/${kind}/${name}.${ext}`;
  if (!NAME_RULES[kind].test(name))
    throw new Error(`Invalid ${kind} file name ${file}`);
  return { plugin, name, file };
}

/** Throws if two plugins define the same skill, prompt or tool name. */
function assertUnique(kind: string, items: { name: string; plugin: string }[]) {
  const seen = new Map<string, string>();
  for (const { name, plugin } of items) {
    const other = seen.get(name);
    if (other)
      throw new Error(
        `Duplicate ${kind} "${name}" in plugins "${other}" and "${plugin}"`
      );
    seen.set(name, plugin);
  }
}

function loadPlugins() {
  const plugins = new Map<string, PluginInfo>();
  for (const [path, json] of Object.entries(MANIFEST_FILES)) {
    const plugin = PATH_RE.exec(path)?.[1];
    if (!plugin) continue;
    const manifest = validate(
      PluginManifestSchema,
      json,
      `plugins/${plugin}/plugin.json`
    );
    plugins.set(plugin, {
      id: plugin,
      ...manifest,
      skills: [],
      prompts: [],
      tools: [],
      workflows: []
    });
  }

  const owner = (plugin: string, file: string) => {
    const p = plugins.get(plugin);
    if (!p)
      throw new Error(
        `${file} belongs to plugin "${plugin}", which has no plugin.json`
      );
    return p;
  };

  for (const [path, text] of Object.entries(SKILL_FILES)) {
    const { plugin, name, file } = locate(path, "skills");
    const { meta, body } = parseMarkdown(SkillMetaSchema, text, file);
    owner(plugin, file).skills.push({ name, plugin, ...meta, body });
  }

  for (const [path, text] of Object.entries(PROMPT_FILES)) {
    const { plugin, name, file } = locate(path, "prompts");
    const { meta, body } = parseMarkdown(PromptMetaSchema, text, file);
    owner(plugin, file).prompts.push({ name, plugin, ...meta, body });
  }

  const tools: RegisteredTool[] = [];
  for (const [path, module] of Object.entries(TOOL_FILES)) {
    const { plugin, name, file } = locate(path, "tools");
    const definition = module.default;
    if (
      !definition?.execute ||
      !definition.inputSchema ||
      !definition.description
    ) {
      throw new Error(
        `${file} must \`export default defineTool({ description, inputSchema, execute })\``
      );
    }
    owner(plugin, file).tools.push({
      name,
      plugin,
      description: definition.description
    });
    tools.push({ ...definition, name, plugin });
  }

  for (const [path, text] of Object.entries(WORKFLOW_FILES)) {
    const { plugin, name, file } = locate(path, "workflows");
    let raw: unknown;
    try {
      raw = parseYaml(text);
    } catch (e) {
      throw new Error(`Invalid YAML in ${file}: ${(e as Error).message}`);
    }
    const workflow = validate(WorkflowSchema, raw, file);
    owner(plugin, file).workflows.push({ name, plugin, ...workflow });
  }

  const all = [...plugins.values()].sort((a, b) => a.id.localeCompare(b.id));
  validateWorkflowReferences(all, tools);
  assertUnique(
    "skill",
    all.flatMap((p) => p.skills)
  );
  // Prompts and workflows share the /command namespace.
  assertUnique(
    "command",
    all.flatMap((p) => [...p.prompts, ...p.workflows])
  );
  assertUnique("tool", tools);
  return { plugins: all, tools };
}

/** Workflow steps may only use existing skills and tools that need no approval (steps run unattended). */
function validateWorkflowReferences(
  plugins: PluginInfo[],
  tools: RegisteredTool[]
) {
  const skills = new Set(plugins.flatMap((p) => p.skills.map((s) => s.name)));
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  for (const w of plugins.flatMap((p) => p.workflows)) {
    const file = `plugins/${w.plugin}/workflows/${w.name}.yaml`;
    for (const step of w.steps) {
      if (step.skill && !skills.has(step.skill)) {
        throw new Error(
          `${file} step "${step.name}" uses unknown skill "${step.skill}"`
        );
      }
      for (const name of step.tools) {
        const t = toolsByName.get(name);
        if (!t)
          throw new Error(
            `${file} step "${step.name}" uses unknown tool "${name}"`
          );
        if (t.needsApproval) {
          throw new Error(
            `${file} step "${step.name}" cannot use "${name}": it requires user approval`
          );
        }
      }
    }
  }
}

const LOADED = loadPlugins();

/** Full plugin catalog (metadata and markdown bodies; no executable code). */
export const listPlugins = (): PluginInfo[] => LOADED.plugins;

export const listSkills = (): SkillInfo[] =>
  LOADED.plugins.flatMap((p) => p.skills);

export const listPrompts = (): PromptInfo[] =>
  LOADED.plugins.flatMap((p) => p.prompts);

export const listTools = (): RegisteredTool[] => LOADED.tools;

export const listWorkflows = (): WorkflowInfo[] =>
  LOADED.plugins.flatMap((p) => p.workflows);

/** Every /command, for the chat's autocomplete. */
export const listCommands = (): CommandInfo[] =>
  LOADED.plugins.flatMap((p) => [
    ...p.prompts.map(({ name, plugin, description, argumentHint }) => ({
      name,
      plugin,
      description,
      argumentHint,
      kind: "prompt" as const
    })),
    ...p.workflows.map(({ name, plugin, description, argumentHint }) => ({
      name,
      plugin,
      description,
      argumentHint,
      kind: "workflow" as const
    }))
  ]);
