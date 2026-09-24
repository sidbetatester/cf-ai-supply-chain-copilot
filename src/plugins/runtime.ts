// Turns the plugin registry into what the LLM sees: the toolset, the
// plugin-derived part of the system prompt, and expanded slash commands.
import { tool, type ToolSet, type UIMessage } from "ai";
import { z } from "zod";
import type { ToolContext } from "./define";
import { parseSlashCommand } from "../shared";
import { listPlugins, listPrompts, listSkills, listTools } from "./registry";

const ARGUMENTS = "$ARGUMENTS";

/**
 * Expand "/<prompt> args" into the prompt's body, substituting $ARGUMENTS (or
 * appending the args if the body has no placeholder). Other text is unchanged.
 */
export function expandSlashCommand(text: string): string {
  const command = parseSlashCommand(text);
  const prompt = command && listPrompts().find((p) => p.name === command.name);
  if (!command || !prompt) return text;
  if (prompt.body.includes(ARGUMENTS)) {
    return prompt.body.replaceAll(ARGUMENTS, command.args || "(none provided)");
  }
  return command.args ? `${prompt.body}\n\n${command.args}` : prompt.body;
}

/** Expand slash commands in user messages before they are sent to the LLM. */
export const expandSlashCommands = (messages: UIMessage[]): UIMessage[] =>
  messages.map((m) =>
    m.role !== "user"
      ? m
      : {
          ...m,
          parts: m.parts.map((p) =>
            p.type === "text" ? { ...p, text: expandSlashCommand(p.text) } : p
          )
        }
  );

/** Built-in tool that loads an on-demand skill's full instructions. */
const USE_SKILL = "useSkill";

export function buildToolset(ctx: ToolContext): ToolSet {
  const tools: ToolSet = {};
  for (const t of listTools()) {
    if (t.name === USE_SKILL)
      throw new Error(
        `Tool name "${USE_SKILL}" is reserved (plugin "${t.plugin}")`
      );
    tools[t.name] = tool({
      description: t.description,
      inputSchema: t.inputSchema,
      needsApproval: t.needsApproval,
      execute: (input: unknown) => t.execute(input, ctx)
    });
  }

  const onDemand = listSkills().filter((s) => !s.always);
  if (onDemand.length > 0) {
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

/** Always-on skill instructions, then a directory of plugins and on-demand skills. */
export function buildPluginPrompt(): string {
  const skills = listSkills();
  const always = skills.filter((s) => s.always).map((s) => s.body);
  const onDemand = skills
    .filter((s) => !s.always)
    .map((s) => `- ${s.name}: ${s.description}`);
  const plugins = listPlugins().map(
    (p) => `- ${p.name} (${p.version}): ${p.description}`
  );

  return [
    ...always,
    `## Plugins\n${plugins.join("\n")}`,
    onDemand.length > 0 &&
      `## Skills\nCall ${USE_SKILL} with the skill name to load its instructions before doing the task it covers:\n${onDemand.join("\n")}`
  ]
    .filter(Boolean)
    .join("\n\n");
}
