// Stateless AI endpoints. The browser owns chats and project data; each
// request carries what the model needs, tools run on that copy, and changes go
// back to the browser to save. The server persists nothing per user.
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  pruneMessages,
  safeValidateUIMessages,
  stepCountIs,
  streamText,
  type UIMessage
} from "ai";
import { z } from "zod";
import { getCatalog } from "./agents/settings-agent";
import { withinRateLimit } from "./agents/guards";
import { USAGE_LIMITER_NAME, type Reservation } from "./agents/usage-limiter";
import { buildSystemPrompt, createModel, neuronsFor } from "./llm";
import { activeSkills, activeWorkflows } from "./plugins/catalog";
import {
  buildToolset,
  expandSlashCommands,
  fillArguments
} from "./plugins/runtime";
import { ProjectStore } from "./project-store";
import { ProjectStateSchema, sha256Hex, type ProjectState } from "./shared";

/** Data parts streamed to the browser: the project after each change. */
export type AppUIMessage = UIMessage<never, { project: ProjectState }>;

const MAX_BODY_BYTES = 512 * 1024;
const MAX_MESSAGES = 100;
const MAX_MESSAGE_CHARS = 8000;
const MAX_CHAT_STEPS = 6;
const MAX_WORKFLOW_TOOL_STEPS = 6;
/**
 * Neurons reserved before a model call (typical: a chat turn with one tool
 * call is ~300); the real usage is settled when the call finishes.
 */
const CHAT_ESTIMATE = 600;
const STEP_ESTIMATE = 500;

const ChatRequestSchema = z.object({
  project: ProjectStateSchema,
  messages: z.array(z.unknown()).min(1).max(MAX_MESSAGES)
});

const StepRequestSchema = z.object({
  project: ProjectStateSchema,
  workflow: z.string().max(64),
  step: z.number().int().min(0).max(9),
  args: z.string().max(MAX_MESSAGE_CHARS).default(""),
  previous: z
    .array(
      z.object({ name: z.string().max(100), text: z.string().max(12_000) })
    )
    .max(10)
    .default([])
});

const error = (status: number, message: string) =>
  Response.json({ error: message }, { status });

/** A per-client key: a daily-rotating hash of the IP (raw IPs are never stored). */
export async function clientKey(request: Request) {
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  return (
    await sha256Hex(`${ip}:${new Date().toISOString().slice(0, 10)}`)
  ).slice(0, 16);
}

export const usageLimiter = (env: Env) =>
  env.UsageLimiter.get(env.UsageLimiter.idFromName(USAGE_LIMITER_NAME));

function budgetExceeded(reservation: Extract<Reservation, { ok: false }>) {
  const ms = Date.parse(reservation.status.resetsAt) - Date.now();
  const inTime = `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
  return error(
    429,
    reservation.reason === "app"
      ? `The demo's daily AI allowance (Cloudflare Workers AI free tier) is used up. It resets at 00:00 UTC, in ${inTime}.`
      : `You've used your share of today's demo AI allowance. It resets at 00:00 UTC, in ${inTime}.`
  );
}

/**
 * Reserve AI budget for one model call. Returns a settle function to record
 * the real usage afterwards, or the 429 Response to send.
 */
type Settle = (usage: {
  inputTokens?: number;
  outputTokens?: number;
}) => Promise<void>;

async function reserveBudget(
  env: Env,
  client: string,
  estimate: number
): Promise<{ settle: Settle } | { response: Response }> {
  const limiter = usageLimiter(env);
  const reservation = await limiter.reserve(client, estimate);
  if (!reservation.ok) return { response: budgetExceeded(reservation) };
  return {
    settle: (usage) => limiter.settle(client, reservation.id, neuronsFor(usage))
  };
}

/**
 * Parse a bounded JSON body, validate it and apply the per-client rate limit.
 * Returns the data, or the error Response to send.
 */
async function readRequest<S extends z.ZodType>(
  request: Request,
  env: Env,
  schema: S
): Promise<{ data: z.infer<S>; client: string } | { response: Response }> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES)
    return { response: error(413, "Request too large") };
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES)
    return { response: error(413, "Request too large") };

  const client = await clientKey(request);
  if (!(await withinRateLimit(env.AI_RATE_LIMITER, `ai:${client}`)))
    return {
      response: error(
        429,
        "Too many requests. Please wait a minute and try again."
      )
    };

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { response: error(400, "Invalid JSON") };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success)
    return {
      response: error(
        400,
        parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")
      )
    };
  return { data: parsed.data, client };
}

const textOf = (message: UIMessage | undefined) =>
  message?.parts
    .flatMap((p) => (p.type === "text" ? [p.text] : []))
    .join("\n") ?? "";

/** POST /api/chat: one chat turn, streamed as AI SDK UI messages. */
export async function handleChat(
  request: Request,
  env: Env
): Promise<Response> {
  const read = await readRequest(request, env, ChatRequestSchema);
  if ("response" in read) return read.response;

  const validated = await safeValidateUIMessages<AppUIMessage>({
    messages: read.data.messages
  });
  if (!validated.success) return error(400, "Invalid messages");
  const messages = validated.data;
  if (textOf(messages.at(-1)).length > MAX_MESSAGE_CHARS)
    return error(
      413,
      `Messages are limited to ${MAX_MESSAGE_CHARS.toLocaleString()} characters`
    );

  const budget = await reserveBudget(env, read.client, CHAT_ESTIMATE);
  if ("response" in budget) return budget.response;

  const catalog = await getCatalog(env);
  const stream = createUIMessageStream<AppUIMessage>({
    execute: async ({ writer }) => {
      const project = new ProjectStore(read.data.project, (state) =>
        writer.write({ type: "data-project", data: state, transient: true })
      );
      const result = streamText({
        model: createModel(env),
        system: buildSystemPrompt(project.snapshot(), catalog),
        messages: pruneMessages({
          messages: await convertToModelMessages(
            expandSlashCommands(messages, catalog)
          ),
          toolCalls: "before-last-2-messages",
          reasoning: "before-last-message"
        }),
        tools: buildToolset(
          { projectId: read.data.project.project.id, project },
          catalog
        ),
        stopWhen: stepCountIs(MAX_CHAT_STEPS),
        abortSignal: request.signal,
        // Record the real cost; a failed or aborted call keeps the estimate.
        onFinish: async ({ totalUsage }) => budget.settle(totalUsage)
      });
      writer.merge(result.toUIMessageStream());
    },
    onError: (e) => (e instanceof Error ? e.message : "Something went wrong")
  });
  return createUIMessageStreamResponse({ stream });
}

/**
 * POST /api/workflow-step: run one step of a plugin workflow (as configured
 * in Settings) with earlier steps' results as context. The browser runs the
 * steps in order and saves the results.
 */
export async function handleWorkflowStep(
  request: Request,
  env: Env
): Promise<Response> {
  const read = await readRequest(request, env, StepRequestSchema);
  if ("response" in read) return read.response;
  const { workflow: name, step: index, args, previous } = read.data;

  const catalog = await getCatalog(env);
  const workflow = activeWorkflows(catalog).find((w) => w.name === name);
  if (!workflow) return error(404, `Workflow /${name} isn't available`);
  const step = workflow.steps[index];
  if (!step) return error(400, `Workflow /${name} has no step ${index + 1}`);

  const budget = await reserveBudget(env, read.client, STEP_ESTIMATE);
  if ("response" in budget) return budget.response;

  const project = new ProjectStore(read.data.project);
  const skill =
    step.skill && activeSkills(catalog).find((s) => s.name === step.skill);
  const { text, totalUsage } = await generateText({
    model: createModel(env),
    system: [
      buildSystemPrompt(project.snapshot(), catalog),
      skill && `## Skill for this step: ${skill.name}\n${skill.body}`
    ]
      .filter(Boolean)
      .join("\n\n"),
    prompt: [
      previous.length > 0 &&
        `Results of earlier steps:\n\n${previous.map((o) => `### ${o.name}\n${o.text}`).join("\n\n")}`,
      `Current step: ${step.name}\n${fillArguments(step.prompt, args)}`
    ]
      .filter(Boolean)
      .join("\n\n"),
    tools: buildToolset(
      { projectId: read.data.project.project.id, project },
      catalog,
      step.tools
    ),
    stopWhen: stepCountIs(MAX_WORKFLOW_TOOL_STEPS),
    abortSignal: request.signal
  });
  await budget.settle(totalUsage);
  return Response.json({
    name: step.name,
    total: workflow.steps.length,
    text,
    project: project.state
  });
}

/** GET /api/usage: today's AI budget, for the demo banner. */
export async function handleUsage(
  request: Request,
  env: Env
): Promise<Response> {
  return Response.json(
    await usageLimiter(env).status(await clientKey(request))
  );
}
