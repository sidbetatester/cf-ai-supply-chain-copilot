import { getAgentByName } from "agents";
import {
  AgentWorkflow,
  type AgentWorkflowEvent,
  type AgentWorkflowStep
} from "agents/workflows";
import { generateText, stepCountIs, type ToolSet } from "ai";
import type { ChatAgent } from "../agents/chat-agent";
import { buildSystemPrompt, createModel } from "../llm";
import {
  listSkills,
  listWorkflows,
  type WorkflowStep
} from "../plugins/registry";
import { buildToolset, fillArguments } from "../plugins/runtime";

export interface PlaybookParams {
  projectId: string;
  chatId: string;
  workflow: string;
  args: string;
}

/** Sent to the ChatAgent after each step, which posts it into the chat. */
export interface PlaybookStepEvent {
  type: "step";
  index: number;
  total: number;
  name: string;
  text: string;
}

interface StepOutput {
  name: string;
  text: string;
}

const MAX_TOOL_STEPS = 8;
const STEP_CONFIG = {
  retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
  timeout: "5 minutes"
} as const;

/**
 * Runs a plugin workflow (plugins/<plugin>/workflows/<name>.yaml) as a durable
 * Cloudflare Workflow: each step is an LLM call with that step's skill and
 * tools, retried on failure, with earlier step outputs as context.
 */
export class PlaybookWorkflow extends AgentWorkflow<ChatAgent, PlaybookParams> {
  async run(
    event: AgentWorkflowEvent<PlaybookParams>,
    step: AgentWorkflowStep
  ) {
    const { workflow: name, args } = event.payload;
    const workflow = listWorkflows().find((w) => w.name === name);
    if (!workflow) throw new Error(`Unknown workflow "${name}"`);

    const outputs: StepOutput[] = [];
    for (const [index, definition] of workflow.steps.entries()) {
      const text = await step.do(
        `${index + 1}. ${definition.name}`,
        STEP_CONFIG,
        () => this.runStep(event.payload, definition, args, outputs)
      );
      outputs.push({ name: definition.name, text });
      await step.sendEvent<PlaybookStepEvent>({
        type: "step",
        index,
        total: workflow.steps.length,
        name: definition.name,
        text
      });
    }
    await step.reportComplete({ workflow: name, steps: outputs.length });
  }

  private async runStep(
    { projectId, chatId }: PlaybookParams,
    definition: WorkflowStep,
    args: string,
    outputs: StepOutput[]
  ): Promise<string> {
    const project = await getAgentByName(this.env.ProjectAgent, projectId);
    const snapshot = await project.snapshot();

    const allTools = buildToolset({ projectId, chatId, project });
    const tools: ToolSet = Object.fromEntries(
      definition.tools.map((t) => [t, allTools[t]])
    );
    const skill =
      definition.skill && listSkills().find((s) => s.name === definition.skill);

    const { text } = await generateText({
      model: createModel(this.env),
      system: [
        buildSystemPrompt(snapshot),
        skill && `## Skill for this step: ${skill.name}\n${skill.body}`
      ]
        .filter(Boolean)
        .join("\n\n"),
      prompt: [
        outputs.length > 0 &&
          `Results of earlier steps:\n\n${outputs.map((o) => `### ${o.name}\n${o.text}`).join("\n\n")}`,
        `Current step: ${definition.name}\n${fillArguments(definition.prompt, args)}`
      ]
        .filter(Boolean)
        .join("\n\n"),
      tools,
      stopWhen: stepCountIs(MAX_TOOL_STEPS)
    });
    return text;
  }
}
