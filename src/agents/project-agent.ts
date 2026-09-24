import { Agent, callable, getAgentByName } from "agents";
import type { scheduleSchema } from "agents/schedule";
import type { z } from "zod";
import { loadProjectData } from "../data";
import {
  analyzeScheduleRisk,
  DEFAULT_CHAT_TITLE,
  PurchaseOrderSchema,
  chatAgentName,
  type ChatMeta,
  type MilestoneUpdate,
  type NewRaidItem,
  type ProjectState,
  type PurchaseOrderPatch,
  sha256Hex
} from "../shared";

import { denySubAgents, isAdminKey, rejectClientStateChange } from "./guards";
/** Tool results are returned to the LLM: success with details, or an error it can act on. */
type ToolResult = { ok: true; [detail: string]: unknown } | { error: string };
type ScheduleInput = z.infer<typeof scheduleSchema>;

const MAX_ACTIVITY = 50;
const MAX_CHATS = 50;
const MAX_RAID_ITEMS = 500;
const MAX_TITLE = 80;

/** Hash of a browser's random owner token (tokens themselves are never stored). */
async function ownerHash(ownerToken: unknown) {
  if (
    typeof ownerToken !== "string" ||
    ownerToken.length < 16 ||
    ownerToken.length > 200
  )
    throw new Error("Invalid owner token");
  return sha256Hex(ownerToken);
}

/**
 * One instance per project (named by project id). Owns the project's data,
 * its chat registry and reminders. Every setState() is pushed live to all
 * connected dashboards; ChatAgents call the domain methods over DO RPC.
 */
export class ProjectAgent extends Agent<Env, ProjectState> {
  // ── Security: state changes are server-only; no sub-agent routes ───

  validateStateChange(_next: unknown, source: unknown) {
    rejectClientStateChange(source);
  }

  onBeforeSubAgent() {
    return denySubAgents();
  }
  onStart() {
    // First run for this instance: load the project named after it from data/.
    if (!this.state?.project)
      this.setState({ ...loadProjectData(this.name), chats: [] });
  }

  /** Apply a mutation to a copy of state, log it, and broadcast. */
  private mutate(activity: string, fn: (s: ProjectState) => void) {
    const next = structuredClone(this.state);
    fn(next);
    next.activity = [
      { ts: new Date().toISOString(), text: activity },
      ...next.activity
    ].slice(0, MAX_ACTIVITY);
    this.setState(next);
  }

  // ── Domain operations (RPC from ChatAgent tools) ──────────────────

  /** Project data plus computed schedule risk, as given to the LLM. */
  snapshot() {
    const { project, orders, milestones, raid } = this.state;
    return {
      project,
      orders,
      milestones,
      raid,
      scheduleRisk: analyzeScheduleRisk(this.state)
    };
  }

  upsertPurchaseOrder({ id, ...fields }: PurchaseOrderPatch): ToolResult {
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
    if (!parsed.success)
      return {
        error: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")
      };
    this.mutate(`${existing ? "Updated" : "Created"} ${id}`, (s) => {
      s.orders = existing
        ? s.orders.map((o) => (o.id === id ? parsed.data : o))
        : [...s.orders, parsed.data];
    });
    return { ok: true, scheduleRisk: analyzeScheduleRisk(this.state) };
  }

  updateMilestone({ id, due, status, reason }: MilestoneUpdate): ToolResult {
    if (!this.state.milestones.some((m) => m.id === id))
      return { error: `Unknown milestone ${id}` };
    this.mutate(`${id} updated: ${reason}`, (s) => {
      const m = s.milestones.find((m) => m.id === id)!;
      if (due) m.due = due;
      if (status) m.status = status;
    });
    return { ok: true, scheduleRisk: analyzeScheduleRisk(this.state) };
  }

  addRaidItems(items: NewRaidItem[]): ToolResult {
    if (this.state.raid.length + items.length > MAX_RAID_ITEMS)
      return {
        error: `The RAID log is limited to ${MAX_RAID_ITEMS} items; close or consolidate items first`
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
    if (!this.state.raid.some((r) => r.id === id))
      return { error: `Unknown RAID item ${id}` };
    this.mutate(`Closed ${id}`, (s) => {
      s.raid.find((r) => r.id === id)!.status = "closed";
    });
    return { ok: true };
  }

  // ── Reminders (DO alarms; fire even when no one is connected) ─────

  async scheduleReminder({
    when,
    description
  }: ScheduleInput): Promise<ToolResult> {
    const input =
      when.type === "scheduled"
        ? when.date
        : when.type === "delayed"
          ? when.delayInSeconds
          : when.type === "cron"
            ? when.cron
            : undefined;
    if (input === undefined) return { error: "No valid schedule given" };
    const task = await this.schedule(input, "fireReminder", description, {
      idempotent: true
    });
    this.mutate(`Reminder scheduled: ${description}`, () => {});
    return { ok: true, id: task.id };
  }

  listReminders() {
    return this.getSchedules().map(({ id, payload, time, type }) => ({
      id,
      description: payload,
      type,
      at: new Date(time * 1000).toISOString()
    }));
  }

  async cancelReminder(id: string): Promise<ToolResult> {
    return (await this.cancelSchedule(id))
      ? { ok: true }
      : { error: `Unknown reminder ${id}` };
  }

  async fireReminder(description: string) {
    this.mutate(`⏰ Reminder: ${description}`, () => {});
    this.broadcast(JSON.stringify({ type: "reminder", description }));
  }

  // ── Chat registry (called from the UI) ────────────────────────────
  // Chats are shared with everyone viewing the project. The browser that
  // creates a chat gets to rename and delete it: it sends a random owner
  // token, and only the token's hash is stored (state is broadcast).

  @callable()
  async createChat(ownerToken: string): Promise<ChatMeta> {
    if (this.state.chats.length >= MAX_CHATS)
      throw new Error(
        `This project has the maximum of ${MAX_CHATS} chats; delete one first.`
      );
    const chat: ChatMeta = {
      id: crypto.randomUUID().slice(0, 8),
      title: DEFAULT_CHAT_TITLE,
      createdAt: new Date().toISOString(),
      ownerHash: await ownerHash(ownerToken)
    };
    this.setState({ ...this.state, chats: [chat, ...this.state.chats] });
    return chat;
  }

  @callable()
  async renameChat(id: string, title: string, ownerToken: string) {
    await this.requireChatOwner(id, ownerToken);
    this.setTitle(id, title);
  }

  @callable()
  async deleteChat(id: string, ownerToken: string) {
    await this.requireChatOwner(id, ownerToken);
    this.setState({
      ...this.state,
      chats: this.state.chats.filter((c) => c.id !== id)
    });
    const chat = await getAgentByName(
      this.env.ChatAgent,
      chatAgentName(this.name, id)
    );
    await chat.destroy();
  }

  /** Called by a ChatAgent on its first message to give the chat a title. */
  titleChatIfUntitled(id: string, firstMessage: string) {
    const chat = this.state.chats.find((c) => c.id === id);
    if (chat?.title === DEFAULT_CHAT_TITLE)
      this.setTitle(id, firstMessage.replace(/\s+/g, " ").slice(0, 60));
  }

  hasChat(id: string) {
    return this.state.chats.some((c) => c.id === id);
  }

  /** Reload project data from data/ files (admin only; chats are kept). */
  @callable()
  async resetProject(adminKey: string) {
    if (!(await isAdminKey(this.env, adminKey)))
      throw new Error("Reloading project data requires the admin key.");
    for (const s of this.getSchedules()) await this.cancelSchedule(s.id);
    this.setState({ ...loadProjectData(this.name), chats: this.state.chats });
  }

  private setTitle(id: string, title: string) {
    const trimmed = title.trim().slice(0, MAX_TITLE);
    if (!trimmed) return;
    this.setState({
      ...this.state,
      chats: this.state.chats.map((c) =>
        c.id === id ? { ...c, title: trimmed } : c
      )
    });
  }

  /** Throws unless the chat exists and `ownerToken` created it (chats from before ownership are open). */
  private async requireChatOwner(id: string, ownerToken: string) {
    const chat = this.state.chats.find((c) => c.id === id);
    if (!chat) throw new Error("That chat no longer exists.");
    if (chat.ownerHash && chat.ownerHash !== (await ownerHash(ownerToken)))
      throw new Error(
        "Only the browser that created this chat can rename or delete it."
      );
  }
}
