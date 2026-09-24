import { defineTool } from "../../../src/plugins/define";
import { MilestoneUpdateSchema } from "../../../src/shared";

export default defineTool({
  description:
    "Update a milestone's status or due date. Changing a due date is a schedule slip and requires the user's approval; only do it when the user asks.",
  inputSchema: MilestoneUpdateSchema,
  // Human-in-the-loop: the PM must approve any re-baseline.
  needsApproval: ({ due }) => due !== undefined,
  execute: async (input, { project }) => await project.updateMilestone(input)
});
