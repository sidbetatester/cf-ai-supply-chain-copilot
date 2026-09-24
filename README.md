# cf_ai_supply_chain_copilot

**An AI program-management copilot for hardware supply chain deployments, built on Cloudflare.**

A supply chain program manager rolling out hardware to a new PoP (point of presence) juggles POs, supplier ETAs, customs lead time, milestones and a RAID log (Risks, Actions, Issues, Decisions). This app puts all of that behind a chat interface, across multiple projects and chats. You can:

- **Ask about risk:** "What's our biggest schedule risk?" The agent checks every gating PO's landed date (ETA + customs buffer) against the milestone it gates, then explains the gap and proposes mitigations.
- **Paste meeting notes:** it extracts risks, actions, issues and decisions into the RAID log and updates the existing POs and milestones.
- **Re-baseline with approval:** moving a milestone date is a schedule slip, so the agent asks the PM to approve it first (human in the loop).
- **Draft status reports:** RAG-rated leadership updates built from live project data.
- **Schedule follow-ups:** "Remind me Friday to chase Contoso". Durable Object alarms fire the reminder later.
- **Talk to it:** a mic button does voice input through the browser's Web Speech API.

A **collapsible sidebar** lists projects and their chats. A **live dashboard** next to the chat (milestones, POs with slack in days, RAID log, agent activity) updates in real time for everyone viewing the project.

> Demo data: two fictional projects, "LOS-02 PoP Expansion" (Lagos) and "FRA-07 Capacity Refresh" (Frankfurt). All suppliers are fictional. LOS-02 has a problem built in on purpose: the core switches land 5 days after the "All hardware on site" milestone.

## Architecture

```
Browser (React + Kumo UI)
  ├─ Sidebar: projects → chats          ┐
  ├─ Dashboard (useAgent state sync) ◄──┤ WebSocket per project
  └─ Chat (useAgentChat)             ◄──┘ WebSocket per chat
                    │
Worker ── /api/projects · routeAgentRequest (rejects unknown projects/chats)
   ├─ ProjectAgent (Durable Object, one per project)
   │    ├─ State: project data loaded from data/, chat registry, activity log
   │    ├─ Domain operations: POs, milestones, RAID items (validated by Zod)
   │    └─ Reminders: this.schedule() → DO alarms → broadcast to viewers
   └─ ChatAgent (Durable Object, one per chat, named "<project>--<chat>")
        ├─ Memory: chat history in DO SQLite
        ├─ LLM: Workers AI · @cf/meta/llama-3.3-70b-instruct-fp8-fast
        └─ Tools → ProjectAgent over Durable Object RPC
```

| Requirement             | Implementation                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LLM                     | Llama 3.3 70B on Workers AI, called through the AI SDK (`workers-ai-provider`) with tool calling                                                          |
| Workflow / coordination | Agents SDK on **Durable Objects**: a multi-step tool-calling loop, human-in-the-loop approvals, agent-to-agent RPC, and scheduled tasks through DO alarms |
| User input              | Chat UI plus voice input (Web Speech API), served as static assets by the same Worker                                                                     |
| Memory / state          | Per-project Durable Object holds structured state synced live to every viewer; per-chat Durable Objects hold message history; both persist in SQLite      |

**Design choice:** schedule-risk math (`analyzeScheduleRisk` in `src/shared.ts`) is deterministic code, not LLM output. The LLM decides _when_ to use it and _explains_ the result, so the numbers it reports are never hallucinated. The dashboard uses the same function.

## Project data

Project data lives in files, not code. Each project has one file per category:

```
data/projects/<project>.json     name, site, goLive, customsBufferDays
data/orders/<project>.csv        id,supplier,item,qty,eta,status,milestoneId
data/milestones/<project>.csv    id,name,due,status
data/raid/<project>.csv          id,type,text,owner,due,severity,status
```

Files are bundled at build time, and every row is validated against the Zod schemas in `src/shared.ts`. A malformed row fails startup with its file and row number. To add a project, add its files. **Reload data** in the UI resets a project to its source files.

## Plugins

Everything the agent can do comes from plugins, including the built-in `core` plugin. A plugin is a folder:

```
plugins/<plugin>/
  plugin.json          { "name", "description", "version" }
  skills/<name>.md     instructions for the agent
  prompts/<name>.md    reusable prompts (become /commands)
  tools/<name>.ts      export default defineTool({ description, inputSchema, execute })
```

- **Skills** have YAML frontmatter `description` and optional `always: true`. Always-on skills are part of every system prompt. Other skills are listed by name and description, and the agent loads one with the built-in `useSkill` tool when a task calls for it, so it always knows what exists without spending context on everything.
- **Prompts** are slash commands: `prompts/notes.md` becomes `/notes`. Frontmatter has `description` and optional `argumentHint`; `$ARGUMENTS` in the body is replaced with what the user types after the command. Typing `/` in the chat opens an autocomplete menu (↑/↓, Tab or Enter; commands without arguments run on Enter). Chats show the command as typed; the server expands it before it reaches the LLM.
- **Tools** are TypeScript files named after the tool (`tools/upsertPurchaseOrder.ts`). `execute(input, ctx)` receives Zod-validated input and a context with the project's `ProjectAgent` RPC stub. `needsApproval(input)` makes the user approve the call first.

Plugins are bundled and validated at build time: bad frontmatter, a missing `plugin.json`, or a name used by two plugins fails startup naming the file. `GET /api/plugins` returns the catalog.

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

1. In **LOS-02**, click **"What's our biggest schedule risk right now?"**
2. Paste meeting notes, e.g. _"Contoso says the core switches slip a week, new ETA 2026-11-25. Decision: pre-stage optics in the racks. Ade to get an air-freight quote by Friday."_ Watch the RAID log and PO slack update on the dashboard.
3. Ask: _"Move M2 to 2026-11-27 to absorb the switch delay"_. Approve or reject the re-baseline.
4. Click **"Draft a weekly status report for leadership"**.
5. Click the **reminder** prompt and wait about a minute for the toast.
6. Open a **new chat** or switch to **FRA-07** from the sidebar. Reload the page: chats and project state persist. **Reload data** restores a project's source files.

## Project layout

- `src/server.ts`: Worker entry, `/api/projects`, agent routing and access guard
- `src/agents/project-agent.ts`: per-project state, domain operations, reminders, chat registry
- `src/agents/chat-agent.ts`: per-chat LLM loop and project context
- `src/plugins/`: plugin author API (`define.ts`), loader (`registry.ts`), toolset and prompt assembly (`runtime.ts`)
- `plugins/core/`: built-in supply chain tools, skills and prompts
- `src/data.ts`: loads and validates `data/`
- `src/shared.ts`: Zod schemas (data validation and tool inputs), types, schedule-risk analysis
- `src/components/`: sidebar, chat, dashboard, tool-call rendering

Built from the [cloudflare/agents-starter](https://github.com/cloudflare/agents-starter) template. See [PROMPTS.md](./PROMPTS.md) for the AI prompts used during development.

## License

MIT © [sidbetatester](https://github.com/sidbetatester). See [LICENSE](./LICENSE); template-derived portions are covered by [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
