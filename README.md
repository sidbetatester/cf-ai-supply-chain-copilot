# cf_ai_supply_chain_copilot

**An AI program-management copilot for hardware supply chain deployments, built on Cloudflare.**

A supply chain program manager rolling out hardware to a new PoP (point of presence) juggles POs, supplier ETAs, customs lead time, milestones and a RAID log (Risks, Actions, Issues, Decisions). This app puts all of that behind a chat interface. You can:

- **Ask about risk:** "What's our biggest schedule risk?" The agent checks every gating PO's landed date (ETA + customs buffer) against the milestone it gates, then explains the gap and proposes mitigations.
- **Paste meeting notes:** it extracts risks, actions, issues and decisions into the RAID log and updates POs and milestones.
- **Re-baseline with approval:** moving a milestone date is a schedule slip, so the agent asks the PM to approve it first (human in the loop).
- **Draft status reports:** RAG-rated leadership updates built from live program data.
- **Schedule follow-ups:** "Remind me Friday to chase Contoso". Durable Object alarms fire the reminder later.
- **Talk to it:** a mic button does voice input through the browser's Web Speech API.

A **live dashboard** next to the chat (milestones, POs with slack in days, RAID log, agent activity) updates in real time as the agent calls tools.

> Demo data: a fictional "LOS-02 PoP Expansion" in Lagos. All suppliers are fictional. The seed data has a problem built in on purpose: the core switches land 5 days after the "All hardware on site" milestone.

## Architecture

```
Browser (React + Kumo UI)
  ├─ Chat (useAgentChat) ─────────┐  WebSocket
  └─ Dashboard (useAgent state) ◄─┤  state sync
                                  ▼
Worker ── routeAgentRequest ──► SupplyChainAgent (Durable Object, one per program)
                                 ├─ Memory: chat history + ProgramState in DO SQLite
                                 ├─ Tools: getProgramSnapshot, upsertPurchaseOrder,
                                 │         updateMilestone (needs approval), addRaidItems,
                                 │         closeRaidItem, schedule/list/cancel reminders
                                 ├─ Scheduling: this.schedule() → DO alarms → executeTask
                                 └─ LLM: Workers AI · @cf/meta/llama-3.3-70b-instruct-fp8-fast
```

| Requirement | Implementation |
|---|---|
| LLM | Llama 3.3 70B on Workers AI, called through the AI SDK (`workers-ai-provider`) with tool calling |
| Workflow / coordination | Agents SDK `AIChatAgent` on **Durable Objects**: a multi-step tool-calling loop, human-in-the-loop approvals, and scheduled tasks through DO alarms |
| User input | Chat UI with streaming responses, plus voice input (Web Speech API), served as static assets by the same Worker |
| Memory / state | Per-program Durable Object: chat history and structured program state (POs, milestones, RAID) persisted in SQLite and synced live to every connected client |

**Design choice:** schedule-risk math (`analyzeScheduleRisk` in `src/shared.ts`) is deterministic code, not LLM output. The LLM decides *when* to call it and *explains* the result, so the numbers it reports are never hallucinated. The dashboard uses the same function.

## Run locally

Requires Node.js 20+ and a (free) Cloudflare account. Workers AI calls run against your account even in local dev.

```bash
npm install
npx wrangler login
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173).

## Deploy

```bash
npm run deploy
```

## Try it

1. Click **"What's our biggest schedule risk right now?"**
2. Click the **supplier-sync meeting notes** prompt. Watch the RAID log and the PO slip update on the dashboard.
3. Ask: *"Move M2 to 2026-11-27 to absorb the switch delay"*. Approve or reject the re-baseline.
4. Click **"Draft a weekly status report for leadership"**.
5. Click the **reminder** prompt and wait about a minute for the toast.
6. Reload the page. The chat and program state persist (Durable Object memory). **Reset demo** restores the seed data.

## Project layout

- `src/server.ts`: the `SupplyChainAgent` Durable Object (system prompt, tools, scheduling)
- `src/shared.ts`: domain model, seed data, deterministic schedule-risk analysis
- `src/app.tsx`: chat UI, voice input, approvals
- `src/dashboard.tsx`: live program dashboard

Built from the [cloudflare/agents-starter](https://github.com/cloudflare/agents-starter) template. See [PROMPTS.md](./PROMPTS.md) for the AI prompts used during development.

## License

MIT © [sidbetatester](https://github.com/sidbetatester). See [LICENSE](./LICENSE); template-derived portions are covered by [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
