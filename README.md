# cf_ai_supply_chain_copilot

**An AI program-management copilot for hardware supply chain deployments, built on Cloudflare.**

**Live demo:** https://cf-ai-supply-chain-copilot.sidsnextbestmove.workers.dev

A supply chain program manager rolling out hardware to a new PoP (point of presence) juggles POs, supplier ETAs, customs lead time, milestones and a RAID log (Risks, Actions, Issues, Decisions). This app puts all of that behind a chat interface, across multiple projects and chats. You can:

- **Ask about risk:** "What's our biggest schedule risk?" The agent checks every gating PO's landed date (ETA + customs buffer) against the milestone it gates, then explains the gap and proposes mitigations.
- **Paste meeting notes:** it extracts risks, actions, issues and decisions into the RAID log and updates the existing POs and milestones.
- **Re-baseline with approval:** moving a milestone date is a schedule slip, so the agent asks the PM to approve it first (human in the loop).
- **Draft status reports:** RAG-rated leadership updates built from the project data.
- **Schedule follow-ups:** "Remind me in an hour to chase Contoso". The reminder is saved with the project and shown when due.
- **Talk to it:** a mic button dictates into the message box (browser Web Speech API) and keeps appending across pauses.
- **Bring your own project:** **Import project** accepts the same JSON and CSV files as `data/`.

A **collapsible sidebar** lists projects and their chats. A **live dashboard** next to the chat (milestones, POs with slack in days, RAID log, agent activity) updates as the agent changes the project.

> **Demo mode:** chats, project changes and imported projects are stored **only in your browser** (IndexedDB), never on the server. Nothing is kept permanently: clearing site data, or using another browser, starts fresh. A banner in the app says so.
>
> Demo data: two fictional projects, "LOS-02 PoP Expansion" (Lagos) and "FRA-07 Capacity Refresh" (Frankfurt), with fictional suppliers. LOS-02 has a problem built in on purpose: the core switches land 5 days after the "All hardware on site" milestone.

## Architecture

```
Browser (React + Kumo UI)                       ← owns all user data
  ├─ IndexedDB: projects (demo copies + imported), chats, messages
  ├─ Chat (AI SDK useChat): POST /api/chat with messages + this browser's project
  │    ◄── streamed reply + "data-project" parts with each change → saved locally
  ├─ /workflow commands: runs steps in order via POST /api/workflow-step
  └─ Dashboard, reminders: from the local project
                    │
Worker (stateless for users)
  ├─ POST /api/chat           Llama 3.3 on Workers AI + plugin tools on the sent project
  ├─ POST /api/workflow-step  one workflow step (its skill and tools) → text + project
  ├─ GET  /api/projects[/id]  read-only demo data bundled from data/
  ├─ GET  /api/plugins        bundled plugin catalog
  └─ SettingsAgent (single Durable Object): admin plugin overrides → effective catalog
```

| Requirement             | Implementation                                                                                                                                                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LLM                     | Llama 3.3 70B on Workers AI, called through the AI SDK (`workers-ai-provider`) with tool calling                                                                                                                                                                              |
| Workflow / coordination | **Workers** run a multi-step tool-calling loop with human-in-the-loop approvals; multi-step plugin **workflows** (e.g. `/weekly-review`) run step by step, each with its own skill and tools and earlier steps' results as context; a **Durable Object** coordinates Settings |
| User input              | Chat UI plus voice dictation (Web Speech API), served as static assets by the same Worker                                                                                                                                                                                     |
| Memory / state          | Per-browser memory in IndexedDB (chats, messages, project data, reminders); the Worker is stateless and each request carries the context it needs; Settings persist in the SettingsAgent's SQLite                                                                             |

**Design choices:**

- **Deterministic numbers.** Schedule-risk math (`analyzeScheduleRisk` in `src/shared.ts`) is code, not LLM output. The LLM decides _when_ to use it and _explains_ the result, so the numbers it reports are never hallucinated. The dashboard uses the same function.
- **No user data on the server.** The browser sends its copy of the project with every request, and the server validates it against the same Zod schemas (with size limits). Tools change an in-memory copy (`ProjectStore` in `src/project-store.ts`), and each change streams back to the browser as a transient data part, which the browser saves.

## Project data

Demo projects are files, not code. Each project has one file per category:

```
data/projects/<project>.json     name, site, goLive, customsBufferDays
data/orders/<project>.csv        id,supplier,item,qty,eta,status,milestoneId
data/milestones/<project>.csv    id,name,due,status
data/raid/<project>.csv          id,type,text,owner,due,severity,status
```

The same parser (`src/project-files.ts`) validates bundled files at build time and files imported in the browser, so both accept exactly the same format. A malformed row, such as an impossible date, is reported with its file and row number. Each browser works on its own copy of a demo project: **Reset data** restores the original, and other visitors never see your changes.

## Plugins

Everything the agent can do comes from plugins, including the built-in `core` plugin. A plugin is a folder:

```
plugins/<plugin>/
  plugin.json            { "name", "description", "version" }
  skills/<name>.md       instructions for the agent
  prompts/<name>.md      reusable prompts (become /commands)
  workflows/<name>.yaml  multi-step /commands
  tools/<name>.ts        export default defineTool({ description, inputSchema, execute })
```

- **Skills** have YAML frontmatter `description` and optional `always: true`. Always-on skills are part of every system prompt. Other skills are listed by name and description, and the agent loads one with the built-in `useSkill` tool when a task calls for it, so it always knows what exists without spending context on everything.
- **Prompts** are slash commands: `prompts/notes.md` becomes `/notes`. Frontmatter has `description` and optional `argumentHint`, and `$ARGUMENTS` in the body is replaced with what the user types after the command. Typing `/` in the chat opens an autocomplete menu (↑/↓, then Tab or Enter; commands without arguments run on Enter). Chats show the command as typed, and the server expands it before it reaches the LLM.
- **Workflows** are multi-step slash commands (`workflows/weekly-review.yaml` → `/weekly-review`). Each step names a `prompt` (with `$ARGUMENTS`), an optional `skill`, and the `tools` it may use. The browser runs the steps in order, passing earlier results along, and posts each result into the chat as it finishes. Steps run unattended, so they can't use tools that need approval (enforced at load).

  ```yaml
  description: Weekly program review
  argumentHint: "[focus for this week]"
  steps:
    - name: Assess schedule risk
      skill: risk-mitigation
      prompt: Assess schedule risk... Context from the user: $ARGUMENTS
    - name: Log follow-up actions
      tools: [addRaidItems]
      prompt: Add an Action item for each recommended mitigation...
  ```

- **Tools** are TypeScript files named after the tool (`tools/upsertPurchaseOrder.ts`). `execute(input, ctx)` receives Zod-validated input and `ctx.project`, the project sent with the request, whose changes are streamed back to the browser. `needsApproval(input)` makes the user approve the call first.

Plugins are bundled and validated at build time: bad frontmatter, a missing `plugin.json`, or a name used by two plugins fails startup naming the file. `GET /api/plugins` returns the bundled catalog, and [Settings](#settings) layers edits on top.

## Settings

The gear icon opens **Settings**, which customizes plugins without touching their files or redeploying. Settings are the deployment's configuration, set by the admin, so they're the one thing stored on the server.

- **Enable or disable** any plugin, skill, command, workflow or tool. Disabled items disappear from the agent's prompt, toolset and `/` menu.
- **Edit** skill instructions (and whether they're always on), command prompts, and workflow steps: add, remove and reorder steps, and pick each step's skill and tools.
- **Create** new skills, commands and workflows with **New**. They live in the built-in **Custom** plugin, go through the same validation as plugin files, and can be deleted. Tools are code, so new tools are added as files in `plugins/<plugin>/tools/`.
- **Reset** one item or everything to the plugin defaults.

A `SettingsAgent` Durable Object stores only overrides, validated with the same Zod schemas as plugin files. One pure resolver (`resolveCatalog` in `src/plugins/catalog.ts`) applies them, on the server for every chat turn and workflow step and in the browser for the `/` menu and the Settings UI, so the two always agree.

**Access:** Settings are **read-only** by default. To edit, click **Unlock editing** and enter the admin key (the `SETTINGS_ADMIN_KEY` Worker secret). It's compared in constant time, unlocks only that connection, and is throttled against guessing. Every write is re-checked on the server. With no key configured, editing is disabled entirely.

## Security and privacy

- **No user data on the server:** chats, messages, project changes, reminders and imported projects stay in the user's browser. Every visitor starts from the unmodified demo data.
- **Nothing can be written to Settings directly:** the SettingsAgent rejects client-sent state (`validateStateChange`); changes go only through validated, admin-checked methods. The SDK's sub-agent route is disabled.
- **Bounded server work:** a per-client rate limit on AI requests (Workers rate-limit binding), a 512 KB request cap, an 8,000-character message cap, and schema limits on every project field and collection.
- **Rendering:** LLM output is shown without raw HTML or images and with only `https`/`mailto` links, plus strict security headers and a `script-src 'self'` Content-Security-Policy (`public/_headers`).
- **Secrets** stay out of git (`.env`, `.dev.vars`), and CI runs with a read-only token.
- Messages and project data are sent to Workers AI to answer a request and aren't stored.

## Run locally

Requires Node.js 20+ and a (free) Cloudflare account. Workers AI calls run against your account even in local dev.

```bash
npm install
npx wrangler login
cp .dev.vars.example .dev.vars   # then set SETTINGS_ADMIN_KEY
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173).

Keep a `.dev.vars` file even if you authenticate with `CLOUDFLARE_API_TOKEN` in `.env`. Without one, the Cloudflare Vite plugin loads `.env` as Worker secrets, exposing the token to the Worker and copying it into `dist/`.

## Deploy

```bash
npm run deploy
npx wrangler secret put SETTINGS_ADMIN_KEY
```

The second command sets the admin key that unlocks Settings editing. Use a long random value.

## Try it

1. In **LOS-02**, click **/risk-review**, or ask _"What's our biggest schedule risk right now?"_
2. Paste meeting notes, e.g. _"Contoso says the core switches slip a week, new ETA 2026-11-25. Decision: pre-stage optics in the racks. Ade to get an air-freight quote by Friday."_ Watch the RAID log and PO slack update on the dashboard.
3. Ask: _"Move M2 to 2026-11-27 to absorb the switch delay"_. Approve or reject the re-baseline.
4. Run **/weekly-review** and watch each step post its result.
5. Ask _"Remind me in 1 minute to review the RAID log"_ and keep the tab open for the reminder.
6. **Import project** with your own JSON and CSV files (the dialog offers templates). Reload the page: everything is still there, in this browser only.

## Project layout

- `src/server.ts`: Worker entry and routes
- `src/chat-api.ts`: stateless `/api/chat` and `/api/workflow-step` (validation, limits, streaming)
- `src/project-store.ts`: project operations used by tools, run on the request's copy of the project
- `src/project-files.ts`: parses and validates project files (bundled `data/` and imports)
- `src/data.ts`: bundles the demo projects from `data/`
- `src/llm.ts`: model setup and system prompt
- `src/plugins/`: plugin author API (`define.ts`), bundled loader (`registry.ts`), schemas and effective-catalog resolver (`catalog.ts`), toolset and prompt assembly (`runtime.ts`)
- `src/agents/settings-agent.ts`: stores and validates Settings overrides and custom items
- `src/agents/guards.ts`: shared security checks (client state writes, admin key, rate limits)
- `src/browser/`: IndexedDB storage and React hooks for projects and chats
- `src/components/`: sidebar, chat, command menu, dashboard, Settings, import dialog, demo banner
- `plugins/core/`: built-in supply chain tools, skills, prompts and workflow

Built from the [cloudflare/agents-starter](https://github.com/cloudflare/agents-starter) template. See [PROMPTS.md](./PROMPTS.md) for the AI prompts used during development.

## License

MIT © [sidbetatester](https://github.com/sidbetatester). See [LICENSE](./LICENSE); template-derived portions are covered by [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
