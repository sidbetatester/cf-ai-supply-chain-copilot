import { useEffect, useState } from "react";
import type { UsageStatus } from "../agents/usage-limiter";

const USAGE_EVENT = "ai-usage-changed";

/** Call after an AI request finishes so the usage display refreshes. */
export const notifyUsageChanged = () =>
  window.dispatchEvent(new Event(USAGE_EVENT));

/** Today's AI budget (Workers AI free tier) for this visitor; undefined until loaded. */
export function useAiUsage() {
  const [usage, setUsage] = useState<UsageStatus>();
  useEffect(() => {
    const load = () =>
      fetch("/api/usage")
        .then((r) => (r.ok ? (r.json() as Promise<UsageStatus>) : undefined))
        .then(setUsage)
        .catch(() => undefined);
    void load();
    window.addEventListener(USAGE_EVENT, load);
    return () => window.removeEventListener(USAGE_EVENT, load);
  }, []);
  return usage;
}
