import { defineTool } from "../../../src/plugins/define";
import { RaidItemSchema } from "../../../src/shared";

export default defineTool({
  description: "Close a RAID item by id (e.g. A-1) once it is resolved.",
  inputSchema: RaidItemSchema.pick({ id: true }),
  execute: async ({ id }, { project }) => await project.closeRaidItem(id)
});
