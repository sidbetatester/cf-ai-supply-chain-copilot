# AI Prompts Used

This project was built with AI-assisted coding (Claude Code), as the assignment encourages. Below are my prompts in order, each followed by a short summary of the outcome. Setup questions that got guidance but no code (Cloudflare login, token permissions and similar) are grouped.

Everything went through feature branches and pull requests on this repository; see the PR history for the code behind each step.

---

## 1. Brainstorm the approach

> Ok, I am working on an optional assignment for my cloudflare job application. Here's the problem statement, I first need you to brainstorm with me on how to attack this problem. I would like you to discuss with me the various options for the UI/UX, the underlying technologies, and the best choices that we can implement without reinventing the wheel from scratch.
> _(followed by the assignment text: LLM, workflow/coordination, user input via chat or voice, memory or state)_

**Outcome:** a proposal to tailor the app to the role (Senior Supply Chain Program Manager) instead of a generic chatbot: a Supply Chain Program Copilot for hardware deployments (POs, milestones, RAID log). Stack: the Cloudflare `agents-starter` template, the Agents SDK on Durable Objects, Llama 3.3 on Workers AI, state synced live to a dashboard, human-in-the-loop approvals and voice input.

## 2. Build the first version

> I like your recommendations and agree with it all. I want to submit the application within a couple of hours so lets aim for best results with least amount of code and effort.

**Outcome:** scaffolded from `agents-starter`. Added supply chain tools with approval-gated milestone changes, deterministic schedule-risk analysis, a live dashboard, voice input and reminders.

Along the way:

- **Duplicated tokens:** Llama 3.3 on Workers AI streams every token twice (in `response` and in `choices[].delta`), which corrupted tool-call JSON. Fixed with the AI SDK's `simulateStreamingMiddleware`.
- **Better tool use:** put the live project state into the system prompt, so the model updates existing POs instead of creating duplicates.

## 3. Cloudflare account setup (guidance)

> so I needsome guidance here, 'npx wrangler login' I ran this, and got back url 'http://localhost:8976/oauth/callback?code=' … it doesnt resolve into anything …
>
> … should I delete all of them other than Workers AI? · is the accout id my claudeflare login id …? · ok, I saved [CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID] in the .env file · it already has all the settings you suggested · check now · ok, you can check now · ok, I setup this worker + sub-domain …

**Outcome:** worked through `wrangler login` callback issues and switched to an API token. Diagnosed three problems by calling the Cloudflare API directly:

- whitespace around `=` in `.env`
- a token whose TTL start date was in the future
- a token with no account access (fixed with a fresh token)

Also registered the `workers.dev` subdomain.

## 4. Turn it into a platform

> Where is the project data coming from, is it hardcoded or do you have source files? I do not want it hardcoded, it must come from data/<catagory>/<sourcefilename>
> Also, we should have the ability to have multiple projects and multiple chats per project, all accessible from a collapsible menu on the left.
> We should be able to configure '/' commands for repeatable requests and workflows.
> I need to have a settings menu where I can configure the workflows > steps/skills/tools necessary for this to be fully functional. We need a plugin functionality with specific directory structure for prompts/skills and tools so it can have standardized customization that will always run an the agent know what skills, tools, exist for it to help the user.

Answering the follow-up questions: `data/<category>/<project>.csv` layout, CSV for tables with JSON metadata, built-in tools plus declarative plugins, and:

> What you have accomplished so far did not take more than an hour, so we still have time, I suggest you itemize the functionality I asked for from foundational to advanced, and then we will implement them one by one, the goal it to keep it as efficient as possible, strictly follow DRY, and the code must be quickly production ready without the need for clean up when we want to make it production

**Outcome:** an 8-item plan, implemented one PR at a time:

1. **File-based data:** `data/` CSV and JSON files, validated by Zod schemas that also define the tool inputs.
2. **Multiple projects and chats:** a `ProjectAgent` per project and a `ChatAgent` per chat, connected by Durable Object RPC, with a route guard.
3. **Collapsible sidebar** listing projects and their chats, with URL routing.
4. **Plugin system:** `plugins/<plugin>/{plugin.json, skills, prompts, tools}`, with always-on and on-demand skills.
5. **Slash commands** from plugin prompts, with autocomplete.
6. **Workflows:** YAML multi-step commands run as durable Cloudflare Workflows.
7. **Settings:** enable, disable and edit plugin content as validated overrides in a `SettingsAgent`.
8. **Ship:** deploy, documentation and prompt history.

## 5. Repository and ownership

> [https://github.com/sidbetatester/cf-ai-supply-chain-copilot] and my github email is available in .env as 'github_email'
>
> I just realized, you have been directly committing everything to main directly without using feat/ branches which should have been a standard practice with merge requests to main at each feature completion. Also, I do not think we should use 'Co-Authored-By: …', this project is not related to anthropic at all and their email id must not be part of our commits. Please clean up! and I see the license file has '2025 Cloudflare Inc.', … please remove any incorrect attributions unless we are using some OSS licensed functionality that requires featuring in our license file. you may use my github profile link as the owner

**Outcome:**

- **History:** rewrote the unpublished history without AI attribution, and adopted `feat/*` and `chore/*` branches with a PR per feature.
- **License:** MIT, © sidbetatester. The template's MIT notice stays, as its license requires, in `THIRD_PARTY_NOTICES.md`.

## 6. Merges and CI

> merged · done · prs merged. · merge done
>
> _(pasted CI analysis)_ Please find a solution for failing job 107600546980 …

**Outcome:** diagnosed the CI failure. `npm ci` rejected a lockfile that npm 11 had written without an optional peer dependency (`@emnapi/runtime`). The fix was to regenerate the lockfile from scratch and verify it under both npm 10 (CI) and npm 11.

The fresh resolve also pulled in `@cloudflare/ai-chat` 0.9.4, which broke chat connections on `agents` 0.17. It was pinned for that fix, then properly resolved by the next prompt.

## 7. Upgrade the Agents SDK

> In the repo … package.json pins "@cloudflare/ai-chat": "0.9.3" because 0.9.4 calls Agent.\_withAgentSpan, which the installed "agents" 0.17.4 doesn't have … Task: on a new branch `chore/upgrade-agents-sdk` … upgrade `agents` to the latest release and `@cloudflare/ai-chat` to its latest compatible version … read the agents changelog for breaking changes … Verify: `npm run check` passes, `npx vite build` succeeds, and in the dev server … a chat message gets an answer, a /weekly-review workflow completes all 3 steps, and project switching works …

**Outcome:** upgraded `agents` 0.17 → 0.24 and `@cloudflare/ai-chat` → 0.12, after reviewing every changelog entry in between. Adapted `chatRecovery`, the chat throttling option and the explicit `@ai-sdk/react` dependency. Verified the migration of existing Durable Object state, and CI passed.

> can you check if this was successful …

**Outcome:** confirmed through the GitHub API that PR #6 was merged and that CI passed on both the PR and `main`.

## 8. Ship

> _(Deploy mode question)_ → Read-only Settings (Recommended)

**Outcome:**

- **Read-only Settings:** Settings are read-only for everyone. A connection can edit only after unlocking with a `SETTINGS_ADMIN_KEY` Worker secret, checked in constant time and enforced per connection on the server.
- **Deployed** to `workers.dev` and verified in production: chat, tool calls, and a full `/weekly-review` Cloudflare Workflow run.
- **Docs:** updated this file and the README.

## 9. Create new plugin content, security and UX review

> where is the ability to add new skills, commands, workflows, tools? · yes, proceed

**Outcome:** a **New** button in Settings creates custom skills, commands and workflows in a built-in "Custom" plugin, validated like plugin files, with name-clash and dependency checks. Tools stay code-only, since running arbitrary code from a browser would be unsafe.

> Why is this distorted, flowing out of the screen instead of perfectly aligning? did you verify the UI/UX properly? · Also, add tool tips to everything that is clickable so the learning curve for the user is almost zero. · Verify there are no security or privacy issues in the current form of the code for an open repository. · check if we completed all planned features and functionality, if anything is missing, line up for completion

**Outcome:**

- **Security review:** a separate reviewer agent found a **critical** issue. Clients could overwrite agent state (including Settings) with a raw WebSocket frame, bypassing the admin key. It was hot-fixed and verified in production, followed by hardening: chat ownership, an admin-only data reset, rate limits and size caps, unlock throttling, safe markdown rendering, a strict CSP and least-privilege CI.
- **Layout:** fixed the overflowing command cards, the dashboard and sidebar breakpoints (the sidebar is now a drawer on phones), and table wrapping. Verified by measurement at 375, 768, 1024, 1280 and 1440 px.
- **Tooltips:** added to every clickable control, including disabled ones, where they explain why the control is unavailable.

## 10. Chats and data belong to each user's browser

> Chats are shared by everyone who opens the app. WHY? I DID NOT ASK FOR CHATS TO BE SHARED BY EVERYONE, ONLY PROJECT DATA IS ACCESSIBLE BUT CHATS SHOULD BE STORED WITHIN EACH USER'S OWN BROWSER, NOT SHARED GLOBALLY. ALSO, IF THE USER HAS NEW PROJECT DATA, THAT MUST BE STORED IN THE BROWSER AND WARN THEM THAT THIS APP IS CURRENTLY IN DEMO MODE AND DOESNT PERMANENTLY STORE ANY DATA. WE DO NOT WANT ANYONE USING UP OUR STORAGE OR SERVERS.
>
> VOICE INPUT IS RECOGNIZING MY VOICE BUT IT REPLACES THE EXISTING TEXT IF I GAVE A GAP IN MY SPEECH AND TRY TO CONTINUE WITH MORE INPUT. · AND I AM NOT ABLE TO DELETE CHATS
>
> _(choices: workflows run from the browser; projects are imported from files)_

**Outcome:** the architecture was redesigned so the server stores no user data:

- **Storage:** chats, messages, project changes, reminders and imported projects live in the browser's IndexedDB.
- **Stateless requests:** `/api/chat` receives the conversation and the project, runs the tools on that copy, and streams each change back for the browser to save.
- **Workflows** run step by step from the browser.
- **Cleanup:** the per-project and per-chat Durable Objects were deleted along with their stored data.
- **UI:** a demo-mode banner explains what's stored; an **Import project** dialog validates files with the same parser as `data/`.
- **Fixes:**
  - Dictation now appends across pauses.
  - Chats can always be deleted.
  - Impossible dates are rejected.
  - Duplicate reminders are prevented.

---

## Runtime prompts (what the agent itself is told)

The agent's instructions live in the plugin files, not in code:

- `plugins/core/skills/program-manager.md`: core rules, always on.
- `plugins/core/skills/status-report.md` and `risk-mitigation.md`: loaded on demand.
- `plugins/core/prompts/*.md`: the `/notes`, `/risk-review` and `/status-report` commands.
- `plugins/core/workflows/weekly-review.yaml`: the multi-step `/weekly-review` workflow.

`src/llm.ts` adds the live project context (project state, today's date, scheduling guidance) to every request.
