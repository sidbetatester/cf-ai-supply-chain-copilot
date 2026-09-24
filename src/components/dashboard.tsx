import { Badge, Surface, Text } from "@cloudflare/kumo";
import {
  analyzeScheduleRisk,
  type MilestoneStatus,
  type ProjectState,
  type RaidType
} from "../shared";

type Rag = "Red" | "Amber" | "Green";

const RAG_CLASS: Record<Rag, string> = {
  Red: "bg-red-500/15 text-red-600 dark:text-red-400 ring-red-500/30",
  Amber: "bg-amber-500/15 text-amber-700 dark:text-amber-400 ring-amber-500/30",
  Green:
    "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 ring-emerald-500/30"
};

const slackRag = (slack: number): Rag =>
  slack < 0 ? "Red" : slack < 5 ? "Amber" : "Green";

const MILESTONE_RAG: Record<MilestoneStatus, Rag | "Done"> = {
  "on-track": "Green",
  "at-risk": "Amber",
  late: "Red",
  done: "Done"
};

const RAID_ICON: Record<RaidType, string> = {
  Risk: "⚠️",
  Action: "✅",
  Issue: "🔥",
  Decision: "⚖️"
};

function Pill({ rag, children }: { rag: Rag; children: React.ReactNode }) {
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ring-1 ${RAG_CLASS[rag]}`}
    >
      {children}
    </span>
  );
}

function Section({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Surface className="rounded-xl ring ring-kumo-line p-4">
      <Text size="xs" variant="secondary" bold>
        {title.toUpperCase()}
      </Text>
      <div className="mt-2">{children}</div>
    </Surface>
  );
}

export function Dashboard({ state }: { state: ProjectState | undefined }) {
  if (!state) {
    return (
      <div className="p-6 text-kumo-inactive text-sm">Loading project…</div>
    );
  }

  const risks = analyzeScheduleRisk(state);
  const slackByPo = new Map(risks.map((r) => [r.poId, r.slackDays]));
  const worst = risks[0]?.slackDays ?? 99;
  const overall = slackRag(worst);
  const openRaid = state.raid.filter((r) => r.status === "open");

  return (
    <div className="space-y-4 p-4">
      {/* Program header */}
      <Surface className="rounded-xl ring ring-kumo-line p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Text variant="heading3" as="h2">
              {state.project.name}
            </Text>
            <Text size="sm" variant="secondary">
              {state.project.site} · Go-live {state.project.goLive}
            </Text>
          </div>
          <Pill rag={overall}>{overall}</Pill>
        </div>
        <Text size="xs" variant="secondary">
          {risks.length > 0 && worst < 0
            ? `Critical path: ${risks[0].item} land ${-worst}d after "${risks[0].milestone}"`
            : "All gating deliveries land before their milestones"}
        </Text>
      </Surface>

      <Section title="Milestones">
        <ul className="space-y-1.5">
          {state.milestones.map((m) => {
            const rag = MILESTONE_RAG[m.status];
            return (
              <li
                key={m.id}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span className="text-kumo-default">
                  <span className="font-mono text-xs text-kumo-subtle mr-2">
                    {m.id}
                  </span>
                  {m.name}
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  <span className="font-mono text-xs text-kumo-subtle">
                    {m.due}
                  </span>
                  {rag === "Done" ? (
                    <Badge variant="secondary">Done</Badge>
                  ) : (
                    <Pill rag={rag}>{m.status}</Pill>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section
        title={`Purchase orders · customs buffer ${state.project.customsBufferDays}d`}
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-kumo-subtle">
              <th className="font-medium pb-1">PO</th>
              <th className="font-medium pb-1">Item</th>
              <th className="font-medium pb-1">ETA</th>
              <th className="font-medium pb-1 text-right">Slack</th>
            </tr>
          </thead>
          <tbody>
            {state.orders.map((po) => {
              const slack = slackByPo.get(po.id);
              return (
                <tr key={po.id} className="border-t border-kumo-line">
                  <td className="py-1.5 font-mono text-xs text-kumo-subtle">
                    {po.id}
                  </td>
                  <td className="py-1.5 text-kumo-default">
                    {po.qty}× {po.item}
                    <div className="text-xs text-kumo-subtle">
                      {po.supplier} · {po.status}
                      {po.milestoneId && ` · gates ${po.milestoneId}`}
                    </div>
                  </td>
                  <td className="py-1.5 font-mono text-xs text-kumo-default">
                    {po.eta}
                  </td>
                  <td className="py-1.5 text-right">
                    {slack === undefined ? (
                      <span className="text-xs text-kumo-subtle">—</span>
                    ) : (
                      <Pill rag={slackRag(slack)}>
                        {slack > 0 ? `+${slack}` : slack}d
                      </Pill>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>

      <Section title={`RAID log · ${openRaid.length} open`}>
        {state.raid.length === 0 ? (
          <Text size="sm" variant="secondary">
            Nothing logged yet. Paste meeting notes into the chat.
          </Text>
        ) : (
          <ul className="space-y-2">
            {[...state.raid].reverse().map((r) => (
              <li
                key={r.id}
                className={`text-sm ${r.status === "closed" ? "opacity-50 line-through" : ""}`}
              >
                <span className="mr-1.5">{RAID_ICON[r.type]}</span>
                <span className="font-mono text-xs text-kumo-subtle mr-1.5">
                  {r.id}
                </span>
                <span className="text-kumo-default">{r.text}</span>
                <div className="text-xs text-kumo-subtle ml-6">
                  {[
                    r.owner,
                    r.due && `due ${r.due}`,
                    r.severity && `${r.severity} severity`
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Agent activity">
        <ul className="space-y-1">
          {state.activity.slice(0, 8).map((a, i) => (
            <li key={`${a.ts}-${i}`} className="text-xs text-kumo-subtle">
              <span className="font-mono mr-2">
                {new Date(a.ts).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit"
                })}
              </span>
              {a.text}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
