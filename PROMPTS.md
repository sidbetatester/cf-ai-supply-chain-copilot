# AI Prompts Used

This project was built with AI-assisted coding (Claude Code, Claude Opus 5.5), as the assignment encourages. My prompts are below in order, followed by a summary of what the assistant did. The full session transcript is also included as `transcript/` (exported from Claude Code).

## 1. Brainstorming

> Ok, I am working on an optional assignment for my cloudflare job application. Here's the problem statement, I first need you to brainstorm with me on how to attack this problem. I would like you to discuss with me the various options for the UI/UX, the underlying technologies, and the best choices that we can implement without reinventing the wheel from scratch.
> *(followed by the pasted assignment text: LLM, workflow/coordination, user input via chat or voice, memory or state)*

**Outcome:** the assistant proposed tailoring the app to the role (Senior Supply Chain Program Manager) instead of building a generic chatbot. It compared four concepts and recommended a "Supply Chain Program Copilot" (PO/milestone tracking plus a RAID log). The stack it recommended was the Cloudflare `agents-starter` template: Agents SDK on Durable Objects, Llama 3.3 on Workers AI, and DO SQLite state synced to a live dashboard. It also suggested human-in-the-loop approvals and voice input.

## 2. Build

> I like your recommendations and agree with it all. I want to submit the application within a couple of hours so lets aim for best results with least amount of code and effort.

**Outcome:** the assistant scaffolded from `cloudflare/agents-starter` and then:
- wrote a typed domain model with seed data and a deterministic schedule-risk function (`src/shared.ts`)
- replaced the starter's demo tools with supply chain tools, and made milestone date changes require user approval (`src/server.ts`)
- switched the model to `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- built a live dashboard fed by agent state sync (`src/dashboard.tsx`)
- added browser voice input and removed the unused MCP and image UI (`src/app.tsx`)
- wrote the README and this file

## Runtime prompt (the agent's system prompt)

See `system:` in `src/server.ts`. In short, it tells the agent to always ground answers in `getProgramSnapshot`, to extract RAID items from notes, to quantify schedule gaps and propose mitigations, and to write RAG-rated status reports.
