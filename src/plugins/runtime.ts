// Turns the effective plugin catalog into what the LLM sees: the toolset, the
// plugin-derived part of the system prompt, and expanded slash commands.
import { tool, type ToolSet, type UIMessage } from "ai";
import { z } from "zod";
import { parseSlashCommand } from "../shared";
import {
  activePrompts,
  activeSkills,
  activeTools,
  type Catalog
} from "./catalog";
import type { ToolContext } from "./define";
import { TOOL_DEFINITIONS } from "./registry";

const ARGUMENTS = "$ARGUMENTS";

/** Built-in tool that loads an on-demand skill's full instructions. */
const USE_SKILL = "useSkill";

/** Substitute $ARGUMENTS in a prompt body, or append the args if it has no placeholder. */
export function fillArguments(body: string, args: string): string {
  if (body.includes(ARGUMENTS))
    return body.replaceAll(ARGUMENTS, args || "(none provided)");
  return args ? `${body}\n\n${args}` : body;
}

/**
 * Expand "/<prompt> args" into the prompt's body (see fillArguments). Other
 * text, including workflow commands, is unchanged.
 */
export function expandSlashCommand(text: string, catalog: Catalog): string {
  const command = parseSlashCommand(text);
  const prompt =
    command && activePrompts(catalog).find((p) => p.name === command.name);
  return command && prompt ? fillArguments(prompt.body, command.args) : text;
}

/** Expand slash commands in user messages before they are sent to the LLM. */
export const expandSlashCommands = (
  messages: UIMessage[],
  catalog: Catalog
): UIMessage[] =>
  messages.map((m) =>
    m.role !== "user"
      ? m
      : {
          ...m,
          parts: m.parts.map((p) =>
            p.type === "text"
              ? { ...p, text: expandSlashCommand(p.text, catalog) }
              : p
          )
        }
  );

/**
 * Enabled tools as an AI SDK toolset, plus useSkill when on-demand skills
 * exist. `only` restricts it to the named tools (workflow steps).
 */
export function buildToolset(
  ctx: ToolContext,
  catalog: Catalog,
  only?: string[]
): ToolSet {
  const tools: ToolSet = {};
  for (const { name } of activeTools(catalog)) {
    const t = TOOL_DEFINITIONS.get(name);
    if (!t || (only && !only.includes(name))) continue;
    if (name === USE_SKILL)
      throw new Error(
        `Tool name "${USE_SKILL}" is reserved (plugin "${t.plugin}")`
      );
    tools[name] = tool({
      description: t.description,
      inputSchema: t.inputSchema,
      needsApproval: t.needsApproval,
      execute: (input: unknown) => t.execute(input, ctx)
    });
  }

  const onDemand = activeSkills(catalog).filter((s) => !s.always);
  if (!only && onDemand.length > 0) {
    const names = onDemand.map((s) => s.name) as [string, ...string[]];
    tools[USE_SKILL] = tool({
      description:
        "Load the full instructions for a skill listed under Skills before doing the task it covers.",
      inputSchema: z.object({ name: z.enum(names) }),
      execute: async ({ name }) => onDemand.find((s) => s.name === name)?.body
    });
  }
  return tools;
}

/** Always-on skill instructions, then a directory of enabled plugins and on-demand skills. */
export function buildPluginPrompt(catalog: Catalog): string {
  const skills = activeSkills(catalog);
  const always = skills.filter((s) => s.always).map((s) => s.body);
  const onDemand = skills
    .filter((s) => !s.always)
    .map((s) => `- ${s.name}: ${s.description}`);
  const plugins = catalog
    .filter((p) => p.enabled)
    .map((p) => `- ${p.name} (${p.version}): ${p.description}`);

  return [
    ...always,
    plugins.length > 0 && `## Plugins\n${plugins.join("\n")}`,
    onDemand.length > 0 &&
      `## Skills\nCall ${USE_SKILL} with the skill name to load its instructions before doing the task it covers:\n${onDemand.join("\n")}`
  ]
    .filter(Boolean)
    .join("\n\n");
}
