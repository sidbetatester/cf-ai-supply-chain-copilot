import { z } from "zod";
import { defineTool } from "../../../src/plugins/define";

export default defineTool({
  description: "Cancel a scheduled reminder by its id (from listReminders).",
  inputSchema: z.object({ id: z.string() }),
  execute: async ({ id }, { project }) => await project.cancelReminder(id)
});
