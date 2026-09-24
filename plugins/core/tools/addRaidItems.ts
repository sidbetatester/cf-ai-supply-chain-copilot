import { z } from "zod";
import { defineTool } from "../../../src/plugins/define";
import { NewRaidItemSchema } from "../../../src/shared";

export default defineTool({
  description:
    "Add one or more Risks, Actions, Issues or Decisions to the RAID log. Record everything from one set of notes in a single call.",
  inputSchema: z.object({ items: z.array(NewRaidItemSchema) }),
  execute: async ({ items }, { project }) => await project.addRaidItems(items)
});
