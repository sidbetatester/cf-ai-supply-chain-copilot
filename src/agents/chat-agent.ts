import { getAgentByName } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  pruneMessages,
  stepCountIs,
  streamText,
  type UIMessage
} from "ai";
import { buildSystemPrompt, createModel } from "../llm";
import type { EffectiveWorkflow } from "../plugins/catalog";
import { buildToolset, expandSlashCommands } from "../plugins/runtime";
import { parseChatAgentName, parseSlashCommand } from "../shared";
import { getCatalog } from "./settings-agent";
import type {
  PlaybookParams,
  PlaybookStepEvent
} from "../workflows/playbook-workflow";

import { denySubAgents, rejectClientStateChange } from "./guards";
const MAX_STEPS = 10;
const WORKFLOW_BINDING = "PLAYBOOK_WORKFLOW";

const textOf = (message: UIMessage | undefined) =>
  message?.parts.find((p) => p.type === "text")?.text ?? "";

/** A one-shot assistant reply that doesn't involve the LLM. */
function replyWith(text: string) {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      const id = crypto.randomUUID();
      writer.write({ type: "text-start", id });
      writer.write({ type: "text-delta", id, delta: text });
      writer.write({ type: "text-end", id });
    }
  });
  return createUIMessageStreamResponse({ stream });
}

/**
 * One instance per chat (named "<projectId>--<chatId>"). Owns only the chat
 * history; all project data lives in the ProjectAgent, reached over DO RPC,
 * so every chat in a project sees and edits the same live data. Tools, skills,
 * commands and workflows come from plugins/.
 */
export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;

  // ── Security: state changes are server-only; no sub-agent routes ───

  validateStateChange(_next: unknown, source: unknown) {
    rejectClientStateChange(source);
  }

  onBeforeSubAgent() {
    return denySubAgents();
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const { projectId, chatId } = parseChatAgentName(this.name);
    const [project, catalog] = await Promise.all([
      getAgentByName(this.env.ProjectAgent, projectId),
      getCatalog(this.env)
    ]);

    const userMessages = this.messages.filter((m) => m.role === "user");
    if (userMessages.length === 1) {
      const text = textOf(userMessages[0]);
      if (text) await project.titleChatIfUntitled(chatId, text);
    }

    const command = parseSlashCommand(textOf(this.messages.at(-1)));
    const workflow =
      command &&
      catalog.flatMap((p) => p.workflows).find((w) => w.name === command.name);
    if (workflow) {
      if (!workflow.enabled)
        return replyWith(
          `Workflow **/${workflow.name}** is disabled in Settings.`
        );
      if (workflow.problems.length > 0) {
        return replyWith(
          `Workflow **/${workflow.name}** can't run as configured. Fix it in Settings:\n\n${workflow.problems.map((p) => `- ${p}`).join("\n")}`
        );
      }
      return this.startWorkflow(workflow, command.args, projectId, chatId);
    }

    const snapshot = await project.snapshot();
    const result = streamText({
      model: createModel(this.env, this.sessionAffinity),
      system: buildSystemPrompt(snapshot, catalog),
      messages: pruneMessages({
        messages: await convertToModelMessages(
          expandSlashCommands(this.messages, catalog)
        ),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: buildToolset({ projectId, chatId, project }, catalog),
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  // ── Workflows ─────────────────────────────────────────────────────

  private async startWorkflow(
    workflow: EffectiveWorkflow,
    args: string,
    projectId: string,
    chatId: string
  ) {
    // The run uses the workflow as configured now, even if Settings change mid-run.
    const { name, steps } = workflow;
    const params: PlaybookParams = {
      projectId,
      chatId,
      workflow: { name, steps },
      args
    };
    await this.runWorkflow(WORKFLOW_BINDING, params);
    return replyWith(
      `▶️ Running workflow **/${name}** (${steps.length} steps). Results will appear here as each step completes.\n\n${steps.map((s, i) => `${i + 1}. ${s.name}`).join("\n")}`
    );
  }

  async onWorkflowEvent(
    _workflowName: string,
    _workflowId: string,
    event: unknown
  ) {
    const e = event as PlaybookStepEvent;
    if (e?.type !== "step") return;
    await this.postAssistantMessage(
      `**Step ${e.index + 1}/${e.total} · ${e.name}**\n\n${e.text}`
    );
  }

  async onWorkflowComplete(
    _workflowName: string,
    _workflowId: string,
    result?: unknown
  ) {
    const { workflow } = (result ?? {}) as { workflow?: string };
    await this.postAssistantMessage(
      `✅ Workflow${workflow ? ` **/${workflow}**` : ""} complete.`
    );
  }

  async onWorkflowError(
    _workflowName: string,
    _workflowId: string,
    error: string
  ) {
    await this.postAssistantMessage(`⚠️ Workflow failed: ${error}`);
  }

  /** Append an assistant message to the chat (persisted and broadcast; no LLM turn). */
  private async postAssistantMessage(text: string) {
    await this.persistMessages([
      ...this.messages,
      {
        id: crypto.randomUUID(),
        role: "assistant",
        parts: [{ type: "text", text }]
      }
    ]);
  }
}
