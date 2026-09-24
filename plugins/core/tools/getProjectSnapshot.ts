import { z } from "zod";
import { defineTool } from "../../../src/plugins/define";

export default defineTool({
  description:
    "Get the full current project state (orders, milestones, RAID log) plus a computed schedule-risk analysis of every PO against the milestone it gates. Use after making changes or when unsure of current values.",
  inputSchema: z.object({}),
  execute: async (_input, { project }) => await project.snapshot()
});
