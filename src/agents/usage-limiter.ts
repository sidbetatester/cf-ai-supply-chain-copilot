import { DurableObject } from "cloudflare:workers";

/** Name of the single UsageLimiter instance. */
export const USAGE_LIMITER_NAME = "global";

export interface UsageStatus {
  /** Neurons used today by the whole app, and the daily budget. */
  used: number;
  budget: number;
  /** Neurons one client may use per day, and how many this client has left. */
  clientBudget: number;
  clientRemaining: number;
  /** When the counters reset (00:00 UTC, like the Workers AI free allocation). */
  resetsAt: string;
}

export type Reservation =
  | { ok: true; id: string; status: UsageStatus }
  | { ok: false; reason: "app" | "client"; status: UsageStatus };

const today = () => new Date().toISOString().slice(0, 10);
const nextReset = () => {
  const d = new Date();
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
  ).toISOString();
};

/**
 * Keeps Workers AI usage inside the free daily allocation. Before each model
 * call the Worker reserves a conservative estimate, then settles the real
 * usage, so concurrent requests can't overshoot. Only daily counters are
 * stored: the app total and one per client (keyed by a hash, not an IP), all
 * wiped when the UTC day changes.
 */
export class UsageLimiter extends DurableObject<Env> {
  private get budget() {
    return Number(this.env.AI_DAILY_NEURON_BUDGET);
  }

  private get clientCap() {
    return Math.floor(this.budget * Number(this.env.AI_CLIENT_DAILY_SHARE));
  }

  /** Start a new day's counters when the UTC date changes. */
  private rollover() {
    const kv = this.ctx.storage.kv;
    if (kv.get<string>("day") !== today()) {
      this.ctx.storage.deleteAll();
      kv.put("day", today());
    }
    return kv;
  }

  private statusFor(client: string): UsageStatus {
    const kv = this.rollover();
    const used = kv.get<number>("total") ?? 0;
    const clientUsed = kv.get<number>(`client:${client}`) ?? 0;
    return {
      used,
      budget: this.budget,
      clientBudget: this.clientCap,
      clientRemaining: Math.max(
        0,
        Math.min(this.clientCap - clientUsed, this.budget - used)
      ),
      resetsAt: nextReset()
    };
  }

  status(client: string): UsageStatus {
    return this.statusFor(client);
  }

  /** Reserve `estimate` neurons for one model call, or refuse if over budget. */
  reserve(client: string, estimate: number): Reservation {
    const kv = this.rollover();
    const total = kv.get<number>("total") ?? 0;
    const clientUsed = kv.get<number>(`client:${client}`) ?? 0;
    if (total + estimate > this.budget)
      return { ok: false, reason: "app", status: this.statusFor(client) };
    if (clientUsed + estimate > this.clientCap)
      return { ok: false, reason: "client", status: this.statusFor(client) };
    kv.put("total", total + estimate);
    kv.put(`client:${client}`, clientUsed + estimate);
    return {
      ok: true,
      id: `${today()}:${estimate}`,
      status: this.statusFor(client)
    };
  }

  /** Replace a reservation's estimate with the neurons actually used. */
  settle(client: string, reservationId: string, actual: number) {
    const [day, estimate] = reservationId.split(":");
    if (day !== today()) return; // The day rolled over; its counters are gone.
    const kv = this.rollover();
    const delta = Math.max(0, actual) - Number(estimate);
    kv.put("total", Math.max(0, (kv.get<number>("total") ?? 0) + delta));
    kv.put(
      `client:${client}`,
      Math.max(0, (kv.get<number>(`client:${client}`) ?? 0) + delta)
    );
  }
}
