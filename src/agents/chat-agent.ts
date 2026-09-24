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
import { listWorkflows, type WorkflowInfo } from "../plugins/registry";
import { buildToolset, expandSlashCommands } from "../plugins/runtime";
import { parseChatAgentName, parseSlashCommand } from "../shared";
import type {
  PlaybookParams,
  PlaybookStepEvent
} from "../workflows/playbook-workflow";

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
  chatRecovery = true;

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const { projectId, chatId } = parseChatAgentName(this.name);
    const project = await getAgentByName(this.env.ProjectAgent, projectId);

    const userMessages = this.messages.filter((m) => m.role === "user");
    if (userMessages.length === 1) {
      const text = textOf(userMessages[0]);
      if (text) await project.titleChatIfUntitled(chatId, text);
    }

    const command = parseSlashCommand(textOf(this.messages.at(-1)));
    const workflow =
      command && listWorkflows().find((w) => w.name === command.name);
    if (workflow)
      return this.startWorkflow(workflow, command.args, projectId, chatId);

    const snapshot = await project.snapshot();
    const result = streamText({
      model: createModel(this.env, this.sessionAffinity),
      system: buildSystemPrompt(snapshot),
      messages: pruneMessages({
        messages: await convertToModelMessages(
          expandSlashCommands(this.messages)
        ),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: buildToolset({ projectId, chatId, project }),
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  // ── Workflows ─────────────────────────────────────────────────────

  private async startWorkflow(
    workflow: WorkflowInfo,
    args: string,
    projectId: string,
    chatId: string
  ) {
    const params: PlaybookParams = {
      projectId,
      chatId,
      workflow: workflow.name,
      args
    };
    await this.runWorkflow(WORKFLOW_BINDING, params);
    const steps = workflow.steps
      .map((s, i) => `${i + 1}. ${s.name}`)
      .join("\n");
    return replyWith(
      `▶️ Running workflow **/${workflow.name}** (${workflow.steps.length} steps). Results will appear here as each step completes.\n\n${steps}`
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
