import { getAgentByName } from "agents";
import { getSchedulePrompt } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { createWorkersAI } from "workers-ai-provider";
import {
  convertToModelMessages,
  pruneMessages,
  simulateStreamingMiddleware,
  stepCountIs,
  streamText,
  wrapLanguageModel
} from "ai";
import { buildPluginPrompt, buildToolset } from "../plugins/runtime";
import { parseChatAgentName } from "../shared";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_STEPS = 10;

/**
 * One instance per chat (named "<projectId>--<chatId>"). Owns only the chat
 * history; all project data lives in the ProjectAgent, reached over DO RPC,
 * so every chat in a project sees and edits the same live data. Tools and
 * skills come from plugins/.
 */
export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const { projectId, chatId } = parseChatAgentName(this.name);
    const project = await getAgentByName(this.env.ProjectAgent, projectId);
    const snapshot = await project.snapshot();

    const userMessages = this.messages.filter((m) => m.role === "user");
    if (userMessages.length === 1) {
      const text = userMessages[0].parts.find((p) => p.type === "text")?.text;
      if (text) await project.titleChatIfUntitled(chatId, text);
    }

    const now = new Date();
    const { project: meta } = snapshot;
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: wrapLanguageModel({
        model: workersai(MODEL, { sessionAffinity: this.sessionAffinity }),
        // Llama 3.3 on Workers AI streams every token (text and tool-call
        // arguments) in both `response` and `choices[].delta`, and
        // workers-ai-provider forwards both, corrupting tool-call JSON. Use the
        // non-streaming endpoint and replay it as a stream instead.
        middleware: simulateStreamingMiddleware()
      }),
      system: `${buildPluginPrompt()}

## Project context
Project: ${meta.name} at ${meta.site}. Go-live target: ${meta.goLive}. Customs buffer: ${meta.customsBufferDays} days.
Today is ${now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })} ${now.toISOString().slice(0, 10)}.

Current project state (source of truth; use these exact ids):
${JSON.stringify(snapshot)}

${getSchedulePrompt({ date: now })}`,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: buildToolset({ projectId, chatId, project }),
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}
