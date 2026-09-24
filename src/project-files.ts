// Parses and validates a project's source files: <project>.json plus optional
// orders/milestones/raid CSVs. Shared by the server's data/ loader and the
// browser's "Import project" dialog, so both accept exactly the same files.
import Papa from "papaparse";
import { validate } from "./validate";
import {
  MilestoneSchema,
  ProjectMetaSchema,
  ProjectStateSchema,
  PurchaseOrderSchema,
  RaidItemSchema,
  type ProjectState
} from "./shared";

/** CSV categories and the schema each row must satisfy. */
export const TABLES = {
  orders: PurchaseOrderSchema,
  milestones: MilestoneSchema,
  raid: RaidItemSchema
} as const;
export type TableCategory = keyof typeof TABLES;
export const TABLE_CATEGORIES = Object.keys(TABLES) as TableCategory[];

export interface ProjectFiles {
  /** Contents of <project>.json (name, site, goLive, customsBufferDays). */
  project: string;
  orders?: string;
  milestones?: string;
  raid?: string;
}

function parseCsv(
  text: string,
  file: string
): Record<string, string | undefined>[] {
  const { data, errors } = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
    transform: (v) => v.trim()
  });
  if (errors.length > 0) {
    throw new Error(
      `CSV parse error in ${file} row ${errors[0].row}: ${errors[0].message}`
    );
  }
  // Empty cells mean "not set" so optional schema fields validate.
  return data.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, v === "" ? undefined : v])
    )
  );
}

/**
 * Validate a project's files; throws with the file (and row) of the first
 * problem. `names` labels each file in error messages.
 */
export function parseProjectFiles(
  id: string,
  files: ProjectFiles,
  names: Partial<Record<keyof ProjectFiles, string>> = {}
): ProjectState {
  const label = (key: keyof ProjectFiles) =>
    names[key] ?? `${key}.${key === "project" ? "json" : "csv"}`;

  let meta: unknown;
  try {
    meta = JSON.parse(files.project);
  } catch (e) {
    throw new Error(
      `${label("project")} isn't valid JSON: ${(e as Error).message}`
    );
  }
  const project = {
    id,
    ...validate(ProjectMetaSchema, meta, label("project"))
  };

  const table = <K extends TableCategory>(key: K) => {
    const text = files[key];
    if (!text?.trim()) return [];
    return parseCsv(text, label(key)).map((row, i) =>
      validate(TABLES[key], row, `${label(key)} row ${i + 2}`)
    );
  };

  // The state schema also enforces the per-project size limits.
  return validate(
    ProjectStateSchema,
    {
      project,
      orders: table("orders"),
      milestones: table("milestones"),
      raid: table("raid"),
      activity: [],
      reminders: []
    },
    `project "${id}"`
  );
}
