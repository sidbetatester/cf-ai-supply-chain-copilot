import { defineTool } from "../../../src/plugins/define";
import { PurchaseOrderPatchSchema } from "../../../src/shared";

export default defineTool({
  description:
    "Create or update a purchase order. Pass an existing id to update it (e.g. a supplier's new ETA); omit fields you are not changing. Never create a duplicate of an existing PO.",
  inputSchema: PurchaseOrderPatchSchema,
  execute: async (input, { project }) =>
    await project.upsertPurchaseOrder(input)
});
