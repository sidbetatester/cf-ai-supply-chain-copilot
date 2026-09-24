import { useEffect, useState } from "react";
import { Button, Text } from "@cloudflare/kumo";
import { DownloadSimpleIcon, InfoIcon, XIcon } from "@phosphor-icons/react";
import {
  parseProjectFiles,
  TABLE_CATEGORIES,
  TABLES,
  type ProjectFiles,
  type TableCategory
} from "../project-files";
import { ProjectMetaSchema, type ProjectState } from "../shared";
import { Tip } from "./tip";

const MAX_FILE_BYTES = 1024 * 1024;

const LABELS: Record<keyof ProjectFiles, string> = {
  project: "Project details (JSON, required)",
  orders: "Purchase orders (CSV)",
  milestones: "Milestones (CSV)",
  raid: "RAID log (CSV)"
};

/** Column names come from the same schemas that validate the files. */
const columns = (key: TableCategory) => Object.keys(TABLES[key].shape);
const projectKeys = Object.keys(ProjectMetaSchema.shape);

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "project";

function uniqueId(name: string, existing: string[]) {
  const base = `my-${slug(name)}`;
  let id = base;
  for (let n = 2; existing.includes(id); n++) id = `${base}-${n}`;
  return id;
}

function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), {
    href: url,
    download: filename
  });
  a.click();
  URL.revokeObjectURL(url);
}

const PROJECT_TEMPLATE = JSON.stringify(
  {
    name: "My PoP Expansion",
    site: "City, Country",
    goLive: "2026-12-31",
    customsBufferDays: 5
  },
  null,
  2
);

/** Import a project from files into this browser (validated like data/). */
export function ImportProjectDialog({
  existingIds,
  onImport,
  onClose
}: {
  existingIds: string[];
  onImport: (state: ProjectState) => void | Promise<void>;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<Partial<Record<keyof ProjectFiles, File>>>(
    {}
  );
  const [result, setResult] = useState<{
    state?: ProjectState;
    error?: string;
  }>({});

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Re-validate whenever the chosen files change.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!files.project) return {};
      const texts: Partial<ProjectFiles> = {};
      for (const [key, file] of Object.entries(files) as [
        keyof ProjectFiles,
        File
      ][]) {
        if (file.size > MAX_FILE_BYTES)
          throw new Error(`${file.name} is larger than 1 MB`);
        texts[key] = await file.text();
      }
      const name = (JSON.parse(texts.project ?? "{}") as { name?: unknown })
        .name;
      const id = uniqueId(
        typeof name === "string" ? name : "project",
        existingIds
      );
      const names = Object.fromEntries(
        Object.entries(files).map(([k, f]) => [k, f.name])
      );
      return { state: parseProjectFiles(id, texts as ProjectFiles, names) };
    })().then(
      (r) => !cancelled && setResult(r),
      (e: Error) => !cancelled && setResult({ error: e.message })
    );
    return () => {
      cancelled = true;
    };
  }, [files, existingIds]);

  const { state, error } = result;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <dialog
        open
        aria-modal="true"
        aria-labelledby="import-title"
        className="static m-0 p-0 border-0 text-kumo-default w-full max-w-xl max-h-[90dvh] overflow-y-auto rounded-2xl bg-kumo-base ring ring-kumo-line shadow-xl"
      >
        <div className="flex items-start justify-between gap-3 px-5 pt-5">
          <div>
            <h2
              id="import-title"
              className="text-lg font-semibold text-kumo-default"
            >
              Import a project
            </h2>
            <Text size="xs" variant="secondary">
              Uses the same files as the repository's data/ folder.
            </Text>
          </div>
          <Tip content="Close without importing">
            <Button
              variant="ghost"
              shape="square"
              aria-label="Close"
              icon={<XIcon size={16} />}
              onClick={onClose}
            />
          </Tip>
        </div>

        <div className="mx-5 mt-4 flex gap-2 rounded-lg px-3 py-2 text-xs bg-sky-500/10 text-sky-900 dark:text-sky-200 ring-1 ring-sky-500/20">
          <InfoIcon size={14} className="mt-0.5 shrink-0" />
          <span>
            Demo mode: the project is saved only in this browser, not on our
            servers, and isn't stored permanently. Keep your original files.
          </span>
        </div>

        <div className="px-5 py-4 space-y-4">
          {(["project", ...TABLE_CATEGORIES] as const).map((key) => (
            <div key={key} className="space-y-1">
              <label
                className="block text-sm font-medium text-kumo-default"
                htmlFor={`import-${key}`}
              >
                {LABELS[key]}
              </label>
              <input
                id={`import-${key}`}
                type="file"
                accept={
                  key === "project" ? ".json,application/json" : ".csv,text/csv"
                }
                className="block w-full text-sm text-kumo-subtle file:mr-3 file:rounded-lg file:border-0 file:bg-kumo-control file:px-3 file:py-1.5 file:text-kumo-default"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  setFiles((prev) => {
                    const next = { ...prev };
                    if (file) next[key] = file;
                    else delete next[key];
                    return next;
                  });
                }}
              />
              <div className="flex flex-wrap items-center gap-x-2 text-xs text-kumo-subtle">
                <span className="font-mono break-all">
                  {key === "project"
                    ? projectKeys.join(", ")
                    : columns(key).join(",")}
                </span>
                <Tip
                  content={`Download an empty ${key === "project" ? "JSON" : "CSV"} template`}
                >
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-kumo-brand hover:underline"
                    onClick={() =>
                      key === "project"
                        ? download(
                            "project.json",
                            PROJECT_TEMPLATE,
                            "application/json"
                          )
                        : download(
                            `${key}.csv`,
                            `${columns(key).join(",")}\n`,
                            "text/csv"
                          )
                    }
                  >
                    <DownloadSimpleIcon size={12} /> template
                  </button>
                </Tip>
              </div>
            </div>
          ))}

          {error && (
            <div
              role="alert"
              className="rounded-lg px-3 py-2 text-sm bg-red-500/10 text-red-700 dark:text-red-300 ring-1 ring-red-500/20 break-words"
            >
              {error}
            </div>
          )}
          {state && (
            <div className="rounded-lg px-3 py-2 text-sm bg-kumo-control">
              <strong>{state.project.name}</strong> · {state.project.site} ·
              go-live {state.project.goLive}
              <div className="text-xs text-kumo-subtle">
                {state.orders.length} purchase orders ·{" "}
                {state.milestones.length} milestones · {state.raid.length} RAID
                items
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 pb-5">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Tip
            content={
              state
                ? "Save this project in this browser and open it"
                : "Choose a valid project JSON file first"
            }
          >
            <Button
              variant="primary"
              disabled={!state}
              onClick={() => state && void onImport(state)}
            >
              Import
            </Button>
          </Tip>
        </div>
      </dialog>
    </div>
  );
}
