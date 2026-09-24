// Project operations used by the agent's tools. They run on the server
// against the copy of the project the browser sent with the request; every
// change is reported through onChange so the browser can save it. Nothing is
// stored on the server.
import type { scheduleSchema } from "agents/schedule";
import type { z } from "zod";
import {
  analyzeScheduleRisk,
  LIMITS,
  PurchaseOrderSchema,
  type MilestoneUpdate,
  type NewRaidItem,
  type ProjectState,
  type PurchaseOrderPatch
} from "./shared";

/** Tool results are returned to the LLM: success with details, or an error it can act on. */
export type ToolResult =
  | { ok: true; [detail: string]: unknown }
  | { error: string };
type ScheduleInput = z.infer<typeof scheduleSchema>;

const issues = (error: z.ZodError) =>
  error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");

export class ProjectStore {
  constructor(
    private current: ProjectState,
    private readonly onChange: (state: ProjectState) => void = () => {}
  ) {}

  get state(): ProjectState {
    return this.current;
  }

  /** Apply a mutation to a copy of the state, log it, and report it. */
  private mutate(activity: string, fn: (s: ProjectState) => void) {
    const next = structuredClone(this.current);
    fn(next);
    next.activity = [
      { ts: new Date().toISOString(), text: activity },
      ...next.activity
    ].slice(0, LIMITS.activity);
    this.current = next;
    this.onChange(next);
  }

  /** Project data plus computed schedule risk, as given to the LLM. */
  snapshot() {
    const { project, orders, milestones, raid } = this.current;
    return {
      project,
      orders,
      milestones,
      raid,
      scheduleRisk: analyzeScheduleRisk(this.current)
    };
  }

  upsertPurchaseOrder({ id, ...fields }: PurchaseOrderPatch): ToolResult {
    const existing = this.current.orders.find((o) => o.id === id);
    if (!existing && this.current.orders.length >= LIMITS.orders)
      return {
        error: `A project can have at most ${LIMITS.orders} purchase orders`
      };
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
    if (!parsed.success) return { error: issues(parsed.error) };
    this.mutate(`${existing ? "Updated" : "Created"} ${id}`, (s) => {
      s.orders = existing
        ? s.orders.map((o) => (o.id === id ? parsed.data : o))
        : [...s.orders, parsed.data];
    });
    return { ok: true, scheduleRisk: analyzeScheduleRisk(this.current) };
  }

  updateMilestone({ id, due, status, reason }: MilestoneUpdate): ToolResult {
    if (!this.current.milestones.some((m) => m.id === id))
      return { error: `Unknown milestone ${id}` };
    this.mutate(`${id} updated: ${reason}`, (s) => {
      const m = s.milestones.find((m) => m.id === id)!;
      if (due) m.due = due;
      if (status) m.status = status;
    });
    return { ok: true, scheduleRisk: analyzeScheduleRisk(this.current) };
  }

  addRaidItems(items: NewRaidItem[]): ToolResult {
    if (this.current.raid.length + items.length > LIMITS.raid)
      return {
        error: `The RAID log is limited to ${LIMITS.raid} items; close or consolidate items first`
      };
    const added: string[] = [];
    this.mutate(`Added ${items.length} RAID item(s)`, (s) => {
      for (const item of items) {
        const id = `${item.type[0]}-${s.raid.filter((r) => r.type === item.type).length + 1}`;
        s.raid.push({ id, status: "open", ...item });
        added.push(id);
      }
    });
    return { ok: true, added };
  }

  closeRaidItem(id: string): ToolResult {
    if (!this.current.raid.some((r) => r.id === id))
      return { error: `Unknown RAID item ${id}` };
    this.mutate(`Closed ${id}`, (s) => {
      s.raid.find((r) => r.id === id)!.status = "closed";
    });
    return { ok: true };
  }

  // ── Reminders: stored with the project; the browser shows them when due ──

  scheduleReminder({ when, description }: ScheduleInput): ToolResult {
    const dueAt =
      when.type === "scheduled"
        ? new Date(when.date)
        : when.type === "delayed"
          ? new Date(Date.now() + when.delayInSeconds * 1000)
          : undefined;
    if (when.type === "cron")
      return {
        error:
          "Recurring reminders aren't available in demo mode; schedule a one-off reminder instead"
      };
    if (!dueAt || Number.isNaN(dueAt.getTime()))
      return { error: "No valid time given for the reminder" };
    // Idempotent: the same pending reminder (same text, due within a minute)
    // is returned instead of duplicated, even if a model repeats the call.
    const duplicate = this.current.reminders.find(
      (r) =>
        !r.fired &&
        r.description.trim().toLowerCase() ===
          description.trim().toLowerCase() &&
        Math.abs(Date.parse(r.dueAt) - dueAt.getTime()) < 60_000
    );
    if (duplicate)
      return {
        ok: true,
        id: duplicate.id,
        dueAt: duplicate.dueAt,
        alreadyScheduled: true
      };
    if (
      this.current.reminders.filter((r) => !r.fired).length >= LIMITS.reminders
    )
      return { error: `At most ${LIMITS.reminders} reminders can be pending` };
    const reminder = {
      id: crypto.randomUUID().slice(0, 8),
      description,
      dueAt: dueAt.toISOString(),
      fired: false
    };
    this.mutate(`Reminder scheduled: ${description}`, (s) => {
      s.reminders = [...s.reminders, reminder];
    });
    return { ok: true, id: reminder.id, dueAt: reminder.dueAt };
  }

  listReminders() {
    return this.current.reminders.filter((r) => !r.fired);
  }

  cancelReminder(id: string): ToolResult {
    if (!this.current.reminders.some((r) => r.id === id && !r.fired))
      return { error: `Unknown reminder ${id}` };
    this.mutate(`Reminder cancelled: ${id}`, (s) => {
      s.reminders = s.reminders.filter((r) => r.id !== id);
    });
    return { ok: true };
  }
}
