import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Schedule } from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool,
  simulateStreamingMiddleware,
  wrapLanguageModel
} from "ai";
import { z } from "zod";
import { loadProjectState } from "./data";
import {
  analyzeScheduleRisk,
  MilestoneSchema,
  PurchaseOrderSchema,
  RaidItemSchema,
  type ProjectState,
  type RaidItem
} from "./shared";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * One Durable Object instance per project, named by project id. Chat history
 * and project state (POs, milestones, RAID log) persist in the DO's SQLite
 * storage, and every setState() is pushed live to connected dashboards.
 */
export class SupplyChainAgent extends AIChatAgent<Env, ProjectState> {
  maxPersistedMessages = 100;
  chatRecovery = true;

  onStart() {
    // First run for this instance: load the project named after it from data/.
    if (!this.state?.project) this.setState(loadProjectState(this.name));
  }

  /** Apply a mutation to a copy of state, log it, and broadcast. */
  private mutate(activity: string, fn: (s: ProjectState) => void) {
    const next = structuredClone(this.state);
    fn(next);
    next.activity = [
      { ts: new Date().toISOString(), text: activity },
      ...next.activity
    ].slice(0, 50);
    this.setState(next);
  }

  /** Project state plus computed schedule risk, as given to the LLM. */
  private snapshot() {
    const { orders, milestones, raid } = this.state;
    return { orders, milestones, raid, scheduleRisk: analyzeScheduleRisk(this.state) };
  }

  @callable()
  async resetProject() {
    for (const s of this.getSchedules()) await this.cancelSchedule(s.id);
    this.setState(loadProjectState(this.name));
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const { project } = this.state;
    const snapshot = this.snapshot();

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

Project: ${project.name} at ${project.site}. Go-live target: ${project.goLive}. Customs buffer: ${project.customsBufferDays} days.
Today is ${new Date().toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })} ${new Date().toISOString().slice(0, 10)}.

Current project state (source of truth; use these exact ids):
${JSON.stringify(snapshot)}

Rules:
- Ground every answer in the project state above (or getProjectSnapshot after changes). Never invent POs, dates or suppliers.
- When the user shares meeting notes or updates: record every risk, action, issue and decision with ONE addRaidItems call, and update EXISTING POs by their id with upsertPurchaseOrder (e.g. a supplier's new ETA updates their existing PO; never create a duplicate). Then reply with a short bullet list of what changed and the new schedule impact.
- When a gating delivery lands after its milestone, say so plainly, quantify the gap in days, and propose concrete mitigations (expedite/air freight, split shipment, alternate supplier, re-sequence work).
- Only change milestone dates or schedule reminders when the user explicitly asks.
- Status reports use RAG (Red/Amber/Green), are concise, and end with asks/decisions needed.
- Keep answers short and scannable; use markdown tables for lists of items.

${getSchedulePrompt({ date: new Date() })}`,
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
          execute: async () => this.snapshot()
        }),

        upsertPurchaseOrder: tool({
          description:
            "Create or update a purchase order. Pass an existing id to update; omit fields you are not changing.",
          inputSchema: PurchaseOrderSchema.partial().required({ id: true }),
          execute: async ({ id, ...fields }) => {
            const existing = this.state.orders.find((o) => o.id === id);
            const changes = Object.fromEntries(
              Object.entries(fields).filter(([, v]) => v !== undefined)
            );
            const parsed = PurchaseOrderSchema.safeParse({
              qty: 1,
              status: "open",
              ...existing,
              ...changes,
              id
            });
            if (!parsed.success) return { error: z.prettifyError(parsed.error) };
            this.mutate(`${existing ? "Updated" : "Created"} ${id}`, (s) => {
              s.orders = existing
                ? s.orders.map((o) => (o.id === id ? parsed.data : o))
                : [...s.orders, parsed.data];
            });
            return { ok: true, scheduleRisk: analyzeScheduleRisk(this.state) };
          }
        }),

        updateMilestone: tool({
          description:
            "Update a milestone's status or due date. Changing a due date is a schedule slip and requires the user's approval.",
          inputSchema: MilestoneSchema.pick({ id: true, due: true, status: true }).partial({ due: true, status: true }).extend({
            reason: z.string().describe("Why this change is being made")
          }),
          // Human-in-the-loop: the PM must approve any re-baseline.
          needsApproval: async ({ due }) => due !== undefined,
          execute: async ({ id, due, status, reason }) => {
            if (!this.state.milestones.some((m) => m.id === id)) {
              return { error: `Unknown milestone ${id}` };
            }
            this.mutate(`${id} updated: ${reason}`, (s) => {
              const m = s.milestones.find((m) => m.id === id)!;
              if (due) m.due = due;
              if (status) m.status = status;
            });
            return { ok: true };
          }
        }),

        addRaidItems: tool({
          description:
            "Add one or more Risks, Actions, Issues or Decisions to the RAID log.",
          inputSchema: z.object({
            items: z.array(RaidItemSchema.omit({ id: true, status: true }))
          }),
          execute: async ({ items }) => {
            const added: RaidItem[] = [];
            this.mutate(`Added ${items.length} RAID item(s)`, (s) => {
              for (const item of items) {
                const n = s.raid.filter((r) => r.type === item.type).length + 1;
                const entry = { id: `${item.type[0]}-${n}`, status: "open" as const, ...item };
                s.raid.push(entry);
                added.push(entry);
              }
            });
            return { added };
          }
        }),

        closeRaidItem: tool({
          description: "Close a RAID item by id (e.g. A-1) once it is resolved.",
          inputSchema: RaidItemSchema.pick({ id: true }),
          execute: async ({ id }) => {
            if (!this.state.raid.some((r) => r.id === id)) {
              return { error: `Unknown RAID item ${id}` };
            }
            this.mutate(`Closed ${id}`, (s) => {
              s.raid.find((r) => r.id === id)!.status = "closed";
            });
            return { ok: true };
          }
        }),

        scheduleTask: tool({
          description:
            "Schedule a follow-up reminder for later. Use when the user asks to be reminded or to chase something.",
          inputSchema: scheduleSchema,
          execute: async ({ when, description }) => {
            if (when.type === "no-schedule") return "Not a valid schedule input";
            const input =
              when.type === "scheduled"
                ? when.date
                : when.type === "delayed"
                  ? when.delayInSeconds
                  : when.type === "cron"
                    ? when.cron
                    : null;
            if (!input) return "Invalid schedule type";
            try {
              await this.schedule(input, "executeTask", description, { idempotent: true });
              return `Reminder scheduled: "${description}" (${when.type}: ${input})`;
            } catch (error) {
              return `Error scheduling task: ${error}`;
            }
          }
        }),

        getScheduledTasks: tool({
          description: "List all scheduled reminders",
          inputSchema: z.object({}),
          execute: async () => {
            const tasks = this.getSchedules();
            return tasks.length > 0 ? tasks : "No scheduled reminders.";
          }
        }),

        cancelScheduledTask: tool({
          description: "Cancel a scheduled reminder by its ID",
          inputSchema: z.object({ taskId: z.string() }),
          execute: async ({ taskId }) => {
            await this.cancelSchedule(taskId);
            return `Reminder ${taskId} cancelled.`;
          }
        })
      },
      stopWhen: stepCountIs(10),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  /** Fired by the Durable Object alarm when a scheduled reminder is due. */
  async executeTask(description: string, _task: Schedule<string>) {
    this.mutate(`⏰ Reminder: ${description}`, () => {});
    // broadcast() (not saveMessages) so the reminder doesn't loop back into the LLM.
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString()
      })
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
