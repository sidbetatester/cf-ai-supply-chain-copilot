// Domain model shared by the agents (server) and the dashboard (client).
// Zod schemas are the single source of truth: they validate source data files,
// type the app, and define the LLM tool inputs.
import { z } from "zod";

/** Bounded text: keeps stored state and LLM prompts small whatever the input. */
const text = (max: number) => z.string().trim().min(1).max(max);
const SHORT = 120;
const LONG = 600;

/** A real calendar date: "2026-02-30" parses but rolls over, so it round-trips. */
const isCalendarDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine(isCalendarDate, "Not a real calendar date")
  .describe("YYYY-MM-DD");

export const POStatusSchema = z.enum([
  "open",
  "shipped",
  "delivered",
  "delayed"
]);
export const MilestoneStatusSchema = z.enum([
  "on-track",
  "at-risk",
  "late",
  "done"
]);
export const RaidTypeSchema = z.enum(["Risk", "Action", "Issue", "Decision"]);
export const SeveritySchema = z.enum(["low", "medium", "high"]);

export const ProjectMetaSchema = z.object({
  name: text(SHORT),
  site: text(SHORT),
  goLive: isoDate,
  customsBufferDays: z.number().int().min(0)
});

export const PurchaseOrderSchema = z.object({
  id: text(40).describe("PO id, e.g. PO-1005"),
  supplier: text(SHORT),
  item: text(SHORT),
  qty: z.coerce.number().int().positive().max(1_000_000),
  eta: isoDate.describe("Arrival at destination port, YYYY-MM-DD"),
  status: POStatusSchema,
  milestoneId: z
    .string()
    .optional()
    .describe("Milestone id this delivery gates, e.g. M2")
});

export const MilestoneSchema = z.object({
  id: text(40).describe("Milestone id, e.g. M2"),
  name: text(SHORT),
  due: isoDate,
  status: MilestoneStatusSchema
});

export const RaidItemSchema = z.object({
  id: text(40),
  type: RaidTypeSchema,
  text: text(LONG),
  owner: text(SHORT).optional(),
  due: isoDate.optional(),
  severity: SeveritySchema.optional(),
  status: z.enum(["open", "closed"])
});

// Mutation inputs: used as LLM tool input schemas and ProjectAgent RPC params.
export const PurchaseOrderPatchSchema = PurchaseOrderSchema.partial().required({
  id: true
});
export const MilestoneUpdateSchema = MilestoneSchema.pick({
  id: true,
  due: true,
  status: true
})
  .partial({ due: true, status: true })
  .extend({ reason: text(LONG).describe("Why this change is being made") });
export const NewRaidItemSchema = RaidItemSchema.omit({
  id: true,
  status: true
});

export type PurchaseOrderPatch = z.infer<typeof PurchaseOrderPatchSchema>;
export type MilestoneUpdate = z.infer<typeof MilestoneUpdateSchema>;
export type NewRaidItem = z.infer<typeof NewRaidItemSchema>;

export type ProjectMeta = z.infer<typeof ProjectMetaSchema>;
export type PurchaseOrder = z.infer<typeof PurchaseOrderSchema>;
export type Milestone = z.infer<typeof MilestoneSchema>;
export type RaidItem = z.infer<typeof RaidItemSchema>;
export type MilestoneStatus = z.infer<typeof MilestoneStatusSchema>;
export type RaidType = z.infer<typeof RaidTypeSchema>;

export const ActivityEntrySchema = z.object({
  ts: z.string().max(40),
  text: text(LONG)
});

/** A one-off follow-up reminder; the browser shows it when it's due. */
export const ReminderSchema = z.object({
  id: text(40),
  description: text(LONG),
  dueAt: z.string().max(40).describe("ISO date-time"),
  fired: z.boolean().default(false)
});

/** Size limits for one project (each browser's copy, and what it may send the server). */
export const LIMITS = {
  orders: 500,
  milestones: 100,
  raid: 500,
  activity: 50,
  reminders: 50,
  chats: 50
} as const;

/**
 * A project's working data. Demo projects start from data/; each browser
 * keeps and edits its own copy (the server stores none of it).
 */
export const ProjectStateSchema = z.object({
  project: ProjectMetaSchema.extend({ id: text(64) }),
  orders: z.array(PurchaseOrderSchema).max(LIMITS.orders),
  milestones: z.array(MilestoneSchema).max(LIMITS.milestones),
  raid: z.array(RaidItemSchema).max(LIMITS.raid),
  activity: z.array(ActivityEntrySchema).max(LIMITS.activity).default([]),
  reminders: z.array(ReminderSchema).max(LIMITS.reminders).default([])
});

export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;
export type Reminder = z.infer<typeof ReminderSchema>;
export type ProjectState = z.infer<typeof ProjectStateSchema>;

/** A chat, stored in the browser with its messages. */
export interface ChatMeta {
  id: string;
  title: string;
  createdAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  site: string;
}

export const DEFAULT_CHAT_TITLE = "New chat";

/** "/name rest of text" → { name, args }; null if the text is not a slash command. */
export function parseSlashCommand(
  text: string
): { name: string; args: string } | null {
  const match = /^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1], args: (match[2] ?? "").trim() } : null;
}

/** Hex SHA-256 via Web Crypto (works in Workers and browsers). */
export const sha256Hex = async (text: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    )
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

export interface ScheduleRisk {
  poId: string;
  item: string;
  supplier: string;
  milestone: string;
  landedDate: string; // ETA + customs buffer
  milestoneDue: string;
  slackDays: number; // negative = late
}

const DAY = 86_400_000;
const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
export const addDays = (s: string, days: number) =>
  new Date(toDate(s).getTime() + days * DAY).toISOString().slice(0, 10);
const diffDays = (a: string, b: string) =>
  Math.round((toDate(a).getTime() - toDate(b).getTime()) / DAY);

/** Deterministic critical-path check: does each gating PO land before its milestone? */
export function analyzeScheduleRisk(state: ProjectState): ScheduleRisk[] {
  return state.orders
    .filter((po) => po.milestoneId && po.status !== "delivered")
    .flatMap((po) => {
      const m = state.milestones.find((m) => m.id === po.milestoneId);
      if (!m) return [];
      const landedDate = addDays(po.eta, state.project.customsBufferDays);
      return [
        {
          poId: po.id,
          item: po.item,
          supplier: po.supplier,
          milestone: m.name,
          landedDate,
          milestoneDue: m.due,
          slackDays: diffDays(m.due, landedDate)
        }
      ];
    })
    .sort((a, b) => a.slackDays - b.slackDays);
}
