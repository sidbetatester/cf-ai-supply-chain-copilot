import { scheduleSchema } from "agents/schedule";
import { defineTool } from "../../../src/plugins/define";

export default defineTool({
  description:
    "Schedule one follow-up reminder for this project, only when the user explicitly asks to be reminded. Call it once per reminder; it is shown in the user's browser when due.",
  inputSchema: scheduleSchema,
  execute: async (input, { project }) => await project.scheduleReminder(input)
});
