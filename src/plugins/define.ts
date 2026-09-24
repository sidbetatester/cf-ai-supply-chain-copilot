// Public API for plugin authors: plugins/<plugin>/tools/<toolName>.ts files
// `export default defineTool({...})`. The file name is the tool name.
import type { z } from "zod";
import type { ProjectAgent } from "../agents/project-agent";

/** Runtime context handed to every tool call. */
export interface ToolContext {
  projectId: string;
  chatId: string;
  /** Typed RPC stub to this chat's ProjectAgent (project data, reminders). */
  project: DurableObjectStub<ProjectAgent>;
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  /** Shown to the LLM; say when to use the tool, not just what it does. */
  description: string;
  inputSchema: S;
  /** Return true to require the user's approval before execute runs. */
  needsApproval?: (input: z.infer<S>) => boolean | Promise<boolean>;
  execute: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
}

export const defineTool = <S extends z.ZodType>(
  definition: ToolDefinition<S>
) => definition;
