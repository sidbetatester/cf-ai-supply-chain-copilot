// Domain model shared by the agents (server) and the dashboard (client).
// Zod schemas are the single source of truth: they validate source data files,
// type the app, and define the LLM tool inputs.
import { z } from "zod";

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .describe("YYYY-MM-DD");

export const POStatusSchema = z.enum(["open", "shipped", "delivered", "delayed"]);
export const MilestoneStatusSchema = z.enum(["on-track", "at-risk", "late", "done"]);
export const RaidTypeSchema = z.enum(["Risk", "Action", "Issue", "Decision"]);
export const SeveritySchema = z.enum(["low", "medium", "high"]);

export const ProjectMetaSchema = z.object({
  name: z.string().min(1),
  site: z.string().min(1),
  goLive: isoDate,
  customsBufferDays: z.number().int().min(0)
});

export const PurchaseOrderSchema = z.object({
  id: z.string().min(1).describe("PO id, e.g. PO-1005"),
  supplier: z.string().min(1),
  item: z.string().min(1),
  qty: z.coerce.number().int().positive(),
  eta: isoDate.describe("Arrival at destination port, YYYY-MM-DD"),
  status: POStatusSchema,
  milestoneId: z.string().optional().describe("Milestone id this delivery gates, e.g. M2")
});

export const MilestoneSchema = z.object({
  id: z.string().min(1).describe("Milestone id, e.g. M2"),
  name: z.string().min(1),
  due: isoDate,
  status: MilestoneStatusSchema
});

export const RaidItemSchema = z.object({
  id: z.string().min(1),
  type: RaidTypeSchema,
  text: z.string().min(1),
  owner: z.string().optional(),
  due: isoDate.optional(),
  severity: SeveritySchema.optional(),
  status: z.enum(["open", "closed"])
});

export type ProjectMeta = z.infer<typeof ProjectMetaSchema>;
export type PurchaseOrder = z.infer<typeof PurchaseOrderSchema>;
export type Milestone = z.infer<typeof MilestoneSchema>;
export type RaidItem = z.infer<typeof RaidItemSchema>;
export type MilestoneStatus = z.infer<typeof MilestoneStatusSchema>;
export type RaidType = z.infer<typeof RaidTypeSchema>;

export interface ActivityEntry {
  ts: string;
  text: string;
}

export interface ProjectState {
  project: ProjectMeta & { id: string };
  orders: PurchaseOrder[];
  milestones: Milestone[];
  raid: RaidItem[];
  activity: ActivityEntry[];
}

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
