// Per-browser storage for chats and project data (IndexedDB via idb-keyval).
// Nothing here reaches the server. If the browser blocks storage (private
// windows, disabled site data), data is kept in memory for this tab instead.
import { createStore, del, get, set, type UseStore } from "idb-keyval";
import type { UIMessage } from "ai";
import type { ChatMeta, ProjectState } from "../shared";

export interface LocalProject {
  /** "demo": a working copy of a bundled demo project; "imported": the user's own files. */
  origin: "demo" | "imported";
  state: ProjectState;
  updatedAt: string;
}

const memory = new Map<string, unknown>();
let db: UseStore | undefined;
let persistent = typeof indexedDB !== "undefined";
try {
  if (persistent) db = createStore("supply-chain-copilot", "data");
} catch {
  persistent = false;
}

/** False when the browser won't persist data (it lasts until the tab closes). */
export const isPersistent = () => persistent;

async function read<T>(key: string): Promise<T | undefined> {
  if (db && persistent) {
    try {
      return await get<T>(key, db);
    } catch {
      persistent = false;
    }
  }
  return memory.get(key) as T | undefined;
}

async function write(key: string, value: unknown) {
  memory.set(key, value);
  if (db && persistent) {
    try {
      await set(key, value, db);
    } catch {
      persistent = false;
    }
  }
}

async function remove(key: string) {
  memory.delete(key);
  if (db && persistent) {
    try {
      await del(key, db);
    } catch {
      persistent = false;
    }
  }
}

const keys = {
  imported: "projects:imported",
  project: (id: string) => `project:${id}`,
  chats: (projectId: string) => `chats:${projectId}`,
  messages: (projectId: string, chatId: string) =>
    `messages:${projectId}:${chatId}`
};

// ── Projects ──────────────────────────────────────────────────────────

export const loadProject = (id: string) => read<LocalProject>(keys.project(id));

export const saveProject = (id: string, project: LocalProject) =>
  write(keys.project(id), project);

export const listImportedProjects = async () =>
  (await read<string[]>(keys.imported)) ?? [];

export async function addImportedProject(id: string, state: ProjectState) {
  const ids = await listImportedProjects();
  await saveProject(id, {
    origin: "imported",
    state,
    updatedAt: new Date().toISOString()
  });
  if (!ids.includes(id)) await write(keys.imported, [...ids, id]);
}

/** Delete a project and all of its chats from this browser. */
export async function deleteProject(id: string) {
  for (const chat of await loadChats(id))
    await remove(keys.messages(id, chat.id));
  await remove(keys.chats(id));
  await remove(keys.project(id));
  await write(
    keys.imported,
    (await listImportedProjects()).filter((p) => p !== id)
  );
}

// ── Chats ─────────────────────────────────────────────────────────────

export const loadChats = async (projectId: string) =>
  (await read<ChatMeta[]>(keys.chats(projectId))) ?? [];

export const saveChats = (projectId: string, chats: ChatMeta[]) =>
  write(keys.chats(projectId), chats);

export const loadMessages = async <M extends UIMessage>(
  projectId: string,
  chatId: string
) => (await read<M[]>(keys.messages(projectId, chatId))) ?? [];

export const saveMessages = (
  projectId: string,
  chatId: string,
  messages: UIMessage[]
) => write(keys.messages(projectId, chatId), messages);

export const deleteMessages = (projectId: string, chatId: string) =>
  remove(keys.messages(projectId, chatId));
