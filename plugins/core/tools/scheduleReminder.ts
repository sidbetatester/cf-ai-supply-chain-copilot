import { scheduleSchema } from "agents/schedule";
import { defineTool } from "../../../src/plugins/define";

export default defineTool({
  description:
    "Schedule a follow-up reminder for this project. Only when the user explicitly asks to be reminded.",
  inputSchema: scheduleSchema,
  execute: async (input, { project }) => await project.scheduleReminder(input)
});
