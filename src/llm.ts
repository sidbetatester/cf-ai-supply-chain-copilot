// Model and system prompt shared by ChatAgent turns and workflow steps.
import { getSchedulePrompt } from "agents/schedule";
import { simulateStreamingMiddleware, wrapLanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { ProjectStore } from "./project-store";
import type { Catalog } from "./plugins/catalog";
import { buildPluginPrompt } from "./plugins/runtime";

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Workers AI cost of MODEL in neurons per million tokens (developers.cloudflare.com
 * /workers-ai/platform/pricing). Update together with MODEL.
 */
const NEURONS_PER_M_INPUT = 26_668;
const NEURONS_PER_M_OUTPUT = 204_805;

/** Neurons consumed by a model response, from its token usage. */
export const neuronsFor = (usage: {
  inputTokens?: number;
  outputTokens?: number;
}) =>
  Math.ceil(
    ((usage.inputTokens ?? 0) * NEURONS_PER_M_INPUT +
      (usage.outputTokens ?? 0) * NEURONS_PER_M_OUTPUT) /
      1_000_000
  );

export type ProjectSnapshot = ReturnType<ProjectStore["snapshot"]>;

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
export function buildSystemPrompt(
  snapshot: ProjectSnapshot,
  catalog: Catalog,
  now = new Date()
) {
  const { project } = snapshot;
  return `${buildPluginPrompt(catalog)}

## Project context
Project: ${project.name} at ${project.site}. Go-live target: ${project.goLive}. Customs buffer: ${project.customsBufferDays} days.
Today is ${now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })} ${now.toISOString().slice(0, 10)}.

Current project state (source of truth; use these exact ids):
${JSON.stringify(snapshot)}

${getSchedulePrompt({ date: now })}`;
}
