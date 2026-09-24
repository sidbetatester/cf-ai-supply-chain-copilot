import { getAgentByName } from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { createWorkersAI } from "workers-ai-provider";
import {
  convertToModelMessages,
  pruneMessages,
  simulateStreamingMiddleware,
  stepCountIs,
  streamText,
  tool,
  wrapLanguageModel
} from "ai";
import { z } from "zod";
import {
  MilestoneUpdateSchema,
  NewRaidItemSchema,
  parseChatAgentName,
  PurchaseOrderPatchSchema,
  RaidItemSchema
} from "../shared";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * One instance per chat (named "<projectId>--<chatId>"). Owns only the chat
 * history; all project data lives in the ProjectAgent, reached over DO RPC,
 * so every chat in a project sees and edits the same live data.
 */
export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;

  private get ids() {
    return parseChatAgentName(this.name);
  }

  private project() {
    return getAgentByName(this.env.ProjectAgent, this.ids.projectId);
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const project = await this.project();
    const snapshot = await project.snapshot();

    const userMessages = this.messages.filter((m) => m.role === "user");
    if (userMessages.length === 1) {
      const text = userMessages[0].parts.find((p) => p.type === "text")?.text;
      if (text) await project.titleChatIfUntitled(this.ids.chatId, text);
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
      system: `You are a Supply Chain Program Copilot helping a program manager deliver a hardware deployment project on time.

Project: ${meta.name} at ${meta.site}. Go-live target: ${meta.goLive}. Customs buffer: ${meta.customsBufferDays} days.
Today is ${now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })} ${now.toISOString().slice(0, 10)}.

Current project state (source of truth; use these exact ids):
${JSON.stringify(snapshot)}

Rules:
- Ground every answer in the project state above (or getProjectSnapshot after changes). Never invent POs, dates or suppliers.
- When the user shares meeting notes or updates: record every risk, action, issue and decision with ONE addRaidItems call, and update EXISTING POs by their id with upsertPurchaseOrder (e.g. a supplier's new ETA updates their existing PO; never create a duplicate). Then reply with a short bullet list of what changed and the new schedule impact.
- When a gating delivery lands after its milestone, say so plainly, quantify the gap in days, and propose concrete mitigations (expedite/air freight, split shipment, alternate supplier, re-sequence work).
- Only change milestone dates or schedule reminders when the user explicitly asks.
- Status reports use RAG (Red/Amber/Green), are concise, and end with asks/decisions needed.
- Keep answers short and scannable; use markdown tables for lists of items.

${getSchedulePrompt({ date: now })}`,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        getProjectSnapshot: tool({
          description:
            "Get the full current project state (orders, milestones, RAID log) plus a computed schedule-risk analysis of every PO against the milestone it gates.",
          inputSchema: z.object({}),
          execute: async () => await project.snapshot()
        }),
        upsertPurchaseOrder: tool({
          description:
            "Create or update a purchase order. Pass an existing id to update; omit fields you are not changing.",
          inputSchema: PurchaseOrderPatchSchema,
          execute: async (input) => await project.upsertPurchaseOrder(input)
        }),
        updateMilestone: tool({
          description:
            "Update a milestone's status or due date. Changing a due date is a schedule slip and requires the user's approval.",
          inputSchema: MilestoneUpdateSchema,
          // Human-in-the-loop: the PM must approve any re-baseline.
          needsApproval: async ({ due }) => due !== undefined,
          execute: async (input) => await project.updateMilestone(input)
        }),
        addRaidItems: tool({
          description:
            "Add one or more Risks, Actions, Issues or Decisions to the RAID log.",
          inputSchema: z.object({ items: z.array(NewRaidItemSchema) }),
          execute: async ({ items }) => await project.addRaidItems(items)
        }),
        closeRaidItem: tool({
          description:
            "Close a RAID item by id (e.g. A-1) once it is resolved.",
          inputSchema: RaidItemSchema.pick({ id: true }),
          execute: async ({ id }) => await project.closeRaidItem(id)
        }),
        scheduleReminder: tool({
          description:
            "Schedule a follow-up reminder. Only when the user asks to be reminded.",
          inputSchema: scheduleSchema,
          execute: async (input) => await project.scheduleReminder(input)
        }),
        listReminders: tool({
          description: "List scheduled reminders for this project.",
          inputSchema: z.object({}),
          execute: async () => await project.listReminders()
        }),
        cancelReminder: tool({
          description: "Cancel a scheduled reminder by its id.",
          inputSchema: z.object({ id: z.string() }),
          execute: async ({ id }) => await project.cancelReminder(id)
        })
      },
      stopWhen: stepCountIs(10),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}
