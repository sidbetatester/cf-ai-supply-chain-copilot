import { z } from "zod";
import { defineTool } from "../../../src/plugins/define";

export default defineTool({
  description: "List scheduled reminders for this project.",
  inputSchema: z.object({}),
  execute: async (_input, { project }) => await project.listReminders()
});
