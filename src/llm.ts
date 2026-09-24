// Model and system prompt shared by ChatAgent turns and workflow steps.
import { getSchedulePrompt } from "agents/schedule";
import { simulateStreamingMiddleware, wrapLanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { ProjectAgent } from "./agents/project-agent";
import { buildPluginPrompt } from "./plugins/runtime";

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export type ProjectSnapshot = ReturnType<ProjectAgent["snapshot"]>;

export function createModel(env: Env, sessionAffinity?: string) {
  const workersai = createWorkersAI({ binding: env.AI });
  return wrapLanguageModel({
    model: workersai(MODEL, { sessionAffinity }),
    // Llama 3.3 on Workers AI streams every token (text and tool-call
    // arguments) in both `response` and `choices[].delta`, and
    // workers-ai-provider forwards both, corrupting tool-call JSON. Use the
    // non-streaming endpoint and replay it as a stream instead.
    middleware: simulateStreamingMiddleware()
  });
}

/** Plugin skills, live project context and scheduling guidance. */
export function buildSystemPrompt(snapshot: ProjectSnapshot, now = new Date()) {
  const { project } = snapshot;
  return `${buildPluginPrompt()}

## Project context
Project: ${project.name} at ${project.site}. Go-live target: ${project.goLive}. Customs buffer: ${project.customsBufferDays} days.
Today is ${now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })} ${now.toISOString().slice(0, 10)}.

Current project state (source of truth; use these exact ids):
${JSON.stringify(snapshot)}

${getSchedulePrompt({ date: now })}`;
}
