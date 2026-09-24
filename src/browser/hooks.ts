// React state over per-browser storage: the current project's working copy
// and its chats. Every change is saved locally; nothing is sent to be stored.
import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_CHAT_TITLE,
  LIMITS,
  type ChatMeta,
  type ProjectState
} from "../shared";
import * as storage from "./storage";

export type ProjectOrigin = storage.LocalProject["origin"];

async function fetchDemoProject(id: string): Promise<ProjectState> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}`);
  if (!response.ok)
    throw new Error(
      `Couldn't load demo project "${id}" (HTTP ${response.status})`
    );
  return response.json() as Promise<ProjectState>;
}

/**
 * This browser's copy of a project. Demo projects start from the bundled
 * data the first time they're opened; `reset` restores that starting data.
 */
export function useLocalProject(projectId: string, origin: ProjectOrigin) {
  const [state, setState] = useState<ProjectState>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await storage.loadProject(projectId);
      if (stored) return stored.state;
      if (origin !== "demo")
        throw new Error("This project isn't stored in this browser any more");
      const fresh = await fetchDemoProject(projectId);
      await storage.saveProject(projectId, {
        origin,
        state: fresh,
        updatedAt: new Date().toISOString()
      });
      return fresh;
    })().then(
      (s) => !cancelled && setState(s),
      (e: Error) => !cancelled && setError(e.message)
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, origin]);

  const update = useCallback(
    (next: ProjectState) => {
      setState(next);
      void storage.saveProject(projectId, {
        origin,
        state: next,
        updatedAt: new Date().toISOString()
      });
    },
    [projectId, origin]
  );

  const reset = useCallback(async () => {
    if (origin !== "demo") return;
    update(await fetchDemoProject(projectId));
  }, [origin, projectId, update]);

  return { state, error, update, reset };
}

/** The chats of one project in this browser. */
export function useChats(projectId: string) {
  const [chats, setChats] = useState<ChatMeta[]>();

  useEffect(() => {
    let cancelled = false;
    storage.loadChats(projectId).then((c) => !cancelled && setChats(c));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const persist = useCallback(
    (next: ChatMeta[]) => {
      setChats(next);
      void storage.saveChats(projectId, next);
    },
    [projectId]
  );

  const create = useCallback((): ChatMeta => {
    const chat = {
      id: crypto.randomUUID().slice(0, 8),
      title: DEFAULT_CHAT_TITLE,
      createdAt: new Date().toISOString()
    };
    // Oldest chats beyond the limit are dropped (with their messages).
    const next = [chat, ...(chats ?? [])];
    for (const old of next.slice(LIMITS.chats))
      void storage.deleteMessages(projectId, old.id);
    persist(next.slice(0, LIMITS.chats));
    return chat;
  }, [chats, persist, projectId]);

  const rename = useCallback(
    (id: string, title: string) => {
      const trimmed = title.trim().slice(0, 80);
      if (trimmed && chats)
        persist(chats.map((c) => (c.id === id ? { ...c, title: trimmed } : c)));
    },
    [chats, persist]
  );

  const remove = useCallback(
    (id: string) => {
      if (!chats) return;
      persist(chats.filter((c) => c.id !== id));
      void storage.deleteMessages(projectId, id);
    },
    [chats, persist, projectId]
  );

  return { chats, create, rename, remove };
}
