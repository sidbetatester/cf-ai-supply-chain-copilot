// Demo projects bundled from data/<category>/<project>.{csv,json} at build
// time (Workers have no runtime filesystem). They're read-only: each browser
// works on its own copy. Malformed files fail startup naming the file and row.
import {
  parseProjectFiles,
  TABLE_CATEGORIES,
  type ProjectFiles
} from "./project-files";
import type { ProjectState, ProjectSummary } from "./shared";

const FILES = import.meta.glob<string>("../data/*/*.{csv,json}", {
  query: "?raw",
  import: "default",
  eager: true
});

const PATH_RE = /\/data\/([^/]+)\/([^/]+)\.(csv|json)$/;

function loadProjects(): Record<string, ProjectState> {
  const byProject = new Map<string, Partial<ProjectFiles>>();
  for (const [path, text] of Object.entries(FILES)) {
    const match = PATH_RE.exec(path);
    if (!match) continue;
    const [, category, projectId, ext] = match;
    const key =
      category === "projects" && ext === "json"
        ? "project"
        : (TABLE_CATEGORIES as string[]).includes(category) && ext === "csv"
          ? (category as keyof ProjectFiles)
          : undefined;
    if (!key) {
      throw new Error(
        `Unrecognized data file data/${category}/${projectId}.${ext}: expected data/projects/<id>.json or data/{${TABLE_CATEGORIES.join(",")}}/<id>.csv`
      );
    }
    byProject.set(projectId, { ...byProject.get(projectId), [key]: text });
  }

  return Object.fromEntries(
    [...byProject].map(([id, files]) => {
      if (!files.project)
        throw new Error(
          `Data files exist for "${id}" but data/projects/${id}.json is missing`
        );
      const names = Object.fromEntries(
        (["project", ...TABLE_CATEGORIES] as const).map((k) => [
          k,
          k === "project" ? `data/projects/${id}.json` : `data/${k}/${id}.csv`
        ])
      );
      return [id, parseProjectFiles(id, files as ProjectFiles, names)];
    })
  );
}

const PROJECTS = loadProjects();

export const listProjects = (): ProjectSummary[] =>
  Object.values(PROJECTS)
    .map(({ project: { id, name, site } }) => ({ id, name, site }))
    .sort((a, b) => a.name.localeCompare(b.name));

/** A demo project's starting data (the browser keeps its own working copy). */
export function demoProject(id: string): ProjectState | undefined {
  const source = PROJECTS[id];
  return source && structuredClone(source);
}
