// Loads project source data from data/<category>/<project>.{csv,json}.
// Files are bundled at build time (Workers have no runtime filesystem) and
// validated against the shared Zod schemas; any malformed row fails fast with
// the offending file and row number.
import Papa from "papaparse";
import { validate } from "./validate";
import {
  MilestoneSchema,
  ProjectMetaSchema,
  PurchaseOrderSchema,
  RaidItemSchema,
  type ProjectState,
  type ProjectSummary
} from "./shared";

const FILES = import.meta.glob<string>("../data/*/*.{csv,json}", {
  query: "?raw",
  import: "default",
  eager: true
});

/** CSV categories and the schema each row must satisfy. */
const TABLES = {
  orders: PurchaseOrderSchema,
  milestones: MilestoneSchema,
  raid: RaidItemSchema
} as const;
type TableCategory = keyof typeof TABLES;

const PATH_RE = /\/data\/([^/]+)\/([^/]+)\.(csv|json)$/;

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

type SourceData = Pick<
  ProjectState,
  "project" | "orders" | "milestones" | "raid"
>;

function loadProjects(): Record<string, SourceData> {
  const metas = new Map<string, ProjectState["project"]>();
  const tables = new Map<string, Partial<Record<TableCategory, unknown[]>>>();

  for (const [path, text] of Object.entries(FILES)) {
    const match = PATH_RE.exec(path);
    if (!match) continue;
    const [, category, projectId, ext] = match;
    const file = `data/${category}/${projectId}.${ext}`;

    if (category === "projects" && ext === "json") {
      metas.set(projectId, {
        id: projectId,
        ...validate(ProjectMetaSchema, JSON.parse(text), file)
      });
    } else if (category in TABLES && ext === "csv") {
      const schema = TABLES[category as TableCategory];
      const rows = parseCsv(text, file).map((row, i) =>
        validate(schema, row, `${file} row ${i + 2}`)
      );
      tables.set(projectId, { ...tables.get(projectId), [category]: rows });
    } else {
      throw new Error(
        `Unrecognized data file ${file}: expected data/projects/<id>.json or data/{${Object.keys(TABLES).join(",")}}/<id>.csv`
      );
    }
  }

  for (const id of tables.keys()) {
    if (!metas.has(id))
      throw new Error(
        `Data files exist for "${id}" but data/projects/${id}.json is missing`
      );
  }

  return Object.fromEntries(
    [...metas].map(([id, project]) => {
      const t = tables.get(id) ?? {};
      return [
        id,
        {
          project,
          orders: (t.orders ?? []) as ProjectState["orders"],
          milestones: (t.milestones ?? []) as ProjectState["milestones"],
          raid: (t.raid ?? []) as ProjectState["raid"]
        }
      ];
    })
  );
}

const PROJECTS = loadProjects();

export const listProjects = (): ProjectSummary[] =>
  Object.values(PROJECTS)
    .map(({ project: { id, name, site } }) => ({ id, name, site }))
    .sort((a, b) => a.name.localeCompare(b.name));

export const projectExists = (id: string) => id in PROJECTS;

/** Fresh, mutable project data from source files (chats are owned by the ProjectAgent). */
export function loadProjectData(id: string): Omit<ProjectState, "chats"> {
  const source = PROJECTS[id];
  if (!source) throw new Error(`Unknown project "${id}"`);
  return {
    ...structuredClone(source),
    activity: [
      { ts: new Date().toISOString(), text: `Loaded from data/*/${id}.*` }
    ]
  };
}
