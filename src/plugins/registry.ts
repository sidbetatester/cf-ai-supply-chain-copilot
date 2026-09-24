// Loads and validates the bundled plugins/<plugin>/{plugin.json,skills,prompts,tools,workflows}.
// Everything is bundled at build time (Workers have no runtime filesystem);
// invalid or conflicting plugin content fails fast, naming the file.
import { parse as parseYaml } from "yaml";
import { parseMarkdown, validate } from "../validate";
import {
  PluginManifestSchema,
  PromptMetaSchema,
  SkillMetaSchema,
  WorkflowSchema,
  workflowProblems,
  type PluginInfo
} from "./catalog";
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
      description: definition.description,
      needsApproval: !!definition.needsApproval
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
  assertValidWorkflows(all);
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

/** Bundled workflows must be valid on their own (Settings can't fix a broken plugin file). */
function assertValidWorkflows(plugins: PluginInfo[]) {
  const skills = new Map(
    plugins.flatMap((p) => p.skills.map((s) => [s.name, true] as const))
  );
  const tools = new Map(
    plugins.flatMap((p) =>
      p.tools.map((t) => [t.name, { ...t, enabled: true }] as const)
    )
  );
  for (const w of plugins.flatMap((p) => p.workflows)) {
    const problems = workflowProblems(w.steps, skills, tools);
    if (problems.length > 0) {
      throw new Error(
        `plugins/${w.plugin}/workflows/${w.name}.yaml: ${problems.join("; ")}`
      );
    }
  }
}
const LOADED = loadPlugins();

/** Plugins as bundled from plugins/ (defaults before Settings overrides). */
export const BUNDLED_PLUGINS: PluginInfo[] = LOADED.plugins;

/** Executable tool definitions, by name. */
export const TOOL_DEFINITIONS = new Map(LOADED.tools.map((t) => [t.name, t]));
