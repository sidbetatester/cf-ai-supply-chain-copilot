import { useCallback, useEffect, useMemo, useState } from "react";
import { useAgent } from "agents/react";
import { Badge, Button, Switch, TooltipProvider } from "@cloudflare/kumo";
import { Toasty, useKumoToastManager } from "@cloudflare/kumo/components/toast";
import {
  ArrowCounterClockwiseIcon,
  BugIcon,
  ChartBarIcon,
  GearSixIcon,
  ListIcon,
  MoonIcon,
  SunIcon,
  TruckIcon
} from "@phosphor-icons/react";
import type { SettingsAgent } from "./agents/settings-agent";
import { useChats, useLocalProject, type ProjectOrigin } from "./browser/hooks";
import * as storage from "./browser/storage";
import {
  EMPTY_OVERRIDES,
  listCommands,
  resolveCatalog,
  SETTINGS_NAME,
  type Catalog,
  type CommandInfo,
  type Overrides,
  type PluginInfo
} from "./plugins/catalog";
import type { ProjectState, ProjectSummary } from "./shared";
import { Chat } from "./components/chat";
import { Dashboard } from "./components/dashboard";
import { DemoBanner } from "./components/demo-banner";
import { ImportProjectDialog } from "./components/import-project";
import { SettingsPanel, type SettingsConnection } from "./components/settings";
import { Sidebar, type SidebarProject } from "./components/sidebar";
import { Tip } from "./components/tip";

// ── Routing: #/<projectId>/<chatId> ───────────────────────────────────

interface Route {
  projectId?: string;
  chatId?: string;
}

const parseHash = (): Route => {
  const [projectId, chatId] = window.location.hash
    .replace(/^#\/?/, "")
    .split("/");
  return { projectId: projectId || undefined, chatId: chatId || undefined };
};

function useHashRoute() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const navigate = useCallback((next: Route, { replace = false } = {}) => {
    const hash = `#/${[next.projectId, next.chatId].filter(Boolean).join("/")}`;
    if (replace) window.history.replaceState(null, "", hash);
    else window.history.pushState(null, "", hash);
    setRoute(next);
  }, []);
  return [route, navigate] as const;
}

// ── Read-only JSON API ────────────────────────────────────────────────

function useApi<T>(path: string) {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  useEffect(() => {
    const controller = new AbortController();
    fetch(path, { signal: controller.signal })
      .then((r) =>
        r.ok
          ? (r.json() as Promise<T>)
          : Promise.reject(new Error(`HTTP ${r.status}`))
      )
      .then((data) => setState({ data }))
      .catch((e: Error) => {
        if (!controller.signal.aborted)
          setState({ error: `${path}: ${e.message}` });
      });
    return () => controller.abort();
  }, [path]);
  return state;
}

// ── Projects imported into this browser ───────────────────────────────

async function loadImportedProjects(): Promise<SidebarProject[]> {
  const list: SidebarProject[] = [];
  for (const id of await storage.listImportedProjects()) {
    const stored = await storage.loadProject(id);
    if (stored)
      list.push({
        id,
        name: stored.state.project.name,
        site: stored.state.project.site,
        origin: "imported"
      });
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

function useImportedProjects() {
  const [projects, setProjects] = useState<SidebarProject[]>();
  useEffect(() => {
    let cancelled = false;
    loadImportedProjects().then((list) => !cancelled && setProjects(list));
    return () => {
      cancelled = true;
    };
  }, []);
  const refresh = useCallback(
    async () => setProjects(await loadImportedProjects()),
    []
  );
  return { projects, refresh };
}
// ── Per-viewer preferences (best effort; storage may be unavailable) ──

function usePersistentFlag(key: string, initial: boolean) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? initial : stored === "1";
    } catch {
      return initial;
    }
  });
  const update = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // Preference just won't persist.
      }
    },
    [key]
  );
  return [value, update] as const;
}

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );
  const toggle = useCallback(() => {
    const mode = dark ? "light" : "dark";
    setDark(!dark);
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    try {
      localStorage.setItem("theme", mode);
    } catch {
      // Preference just won't persist.
    }
  }, [dark]);
  return (
    <Tip
      content={dark ? "Switch to light mode" : "Switch to dark mode"}
      side="bottom"
    >
      <Button
        variant="secondary"
        shape="square"
        icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
        onClick={toggle}
        aria-label="Toggle theme"
      />
    </Tip>
  );
}

// ── Workspace: one project and its chats ──────────────────────────────

const REMINDER_CHECK_MS = 15_000;

function Workspace({
  projects,
  project: current,
  catalog,
  commands,
  settings,
  chatId,
  navigate,
  onImportProject,
  onDeleteProject
}: {
  projects: SidebarProject[];
  project: SidebarProject;
  catalog: Catalog;
  commands: CommandInfo[];
  settings: SettingsConnection;
  chatId: string | undefined;
  navigate: ReturnType<typeof useHashRoute>[1];
  onImportProject: () => void;
  onDeleteProject: (id: string) => void;
}) {
  const projectId = current.id;
  const toasts = useKumoToastManager();
  const local = useLocalProject(projectId, current.origin);
  const { chats, create, rename, remove } = useChats(projectId);
  const [showDebug, setShowDebug] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false); // small screens
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistentFlag(
    "sidebarCollapsed",
    window.innerWidth < 768
  );
  const workflows = useMemo(
    () => catalog.flatMap((p) => p.workflows),
    [catalog]
  );

  // On small screens the sidebar is a drawer: close it once a choice is made.
  const closeSidebarOnMobile = useCallback(() => {
    if (window.matchMedia("(max-width: 767px)").matches)
      setSidebarCollapsed(true);
  }, [setSidebarCollapsed]);

  const selectChat = useCallback(
    (id: string, opts?: { replace?: boolean }) =>
      navigate({ projectId, chatId: id }, opts),
    [navigate, projectId]
  );
  const newChat = useCallback(
    () => selectChat(create().id),
    [create, selectChat]
  );

  // Keep the route pointing at a real chat: open the newest, or create one.
  useEffect(() => {
    if (!chats || (chatId && chats.some((c) => c.id === chatId))) return;
    selectChat(chats[0]?.id ?? create().id, { replace: true });
  }, [chats, chatId, create, selectChat]);

  // Reminders live in the project data; show them when due (while the app is open).
  const { state, update } = local;
  useEffect(() => {
    if (!state) return;
    const check = () => {
      const now = Date.now();
      const due = state.reminders.filter(
        (r) => !r.fired && Date.parse(r.dueAt) <= now
      );
      if (due.length === 0) return;
      for (const r of due)
        toasts.add({
          title: "⏰ Reminder",
          description: r.description,
          timeout: 0
        });
      update({
        ...state,
        reminders: state.reminders.map((r) =>
          due.includes(r) ? { ...r, fired: true } : r
        )
      });
    };
    check();
    const timer = window.setInterval(check, REMINDER_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [state, update, toasts]);

  const activeChat =
    chatId && chats?.some((c) => c.id === chatId) ? chatId : undefined;

  return (
    <div className="flex flex-col h-dvh bg-kumo-elevated">
      <header className="px-4 py-3 bg-kumo-base border-b border-kumo-line">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="md:hidden">
              <Tip content="Show or hide projects and chats" side="bottom">
                <Button
                  variant="ghost"
                  shape="square"
                  aria-label="Toggle sidebar"
                  icon={<ListIcon size={18} />}
                  onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                />
              </Tip>
            </span>
            <h1 className="text-lg font-semibold text-kumo-default truncate">
              <TruckIcon
                size={20}
                weight="duotone"
                className="inline mr-2 -mt-0.5 text-kumo-brand"
              />
              Supply Chain Copilot
            </h1>
            <Badge variant="secondary" className="hidden lg:inline-flex">
              Llama 3.3 · Workers AI
            </Badge>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <Tip content="Debug: show each message's raw data" side="bottom">
              <div className="hidden md:flex items-center gap-1.5">
                <BugIcon size={14} className="text-kumo-inactive" />
                <Switch
                  checked={showDebug}
                  onCheckedChange={setShowDebug}
                  size="sm"
                  aria-label="Toggle debug mode"
                />
              </div>
            </Tip>
            <ThemeToggle />
            <Tip
              content="Settings: plugins, skills, commands, workflows and tools"
              side="bottom"
            >
              <Button
                variant="secondary"
                shape="square"
                aria-label="Settings"
                icon={<GearSixIcon size={16} />}
                onClick={() => setShowSettings(true)}
              />
            </Tip>
            <span className="xl:hidden">
              <Tip
                content={
                  showDashboard
                    ? "Back to the chat"
                    : "Show the project dashboard"
                }
                side="bottom"
              >
                <Button
                  variant={showDashboard ? "primary" : "secondary"}
                  shape="square"
                  aria-label="Toggle dashboard"
                  aria-pressed={showDashboard}
                  icon={<ChartBarIcon size={16} />}
                  onClick={() => setShowDashboard((v) => !v)}
                />
              </Tip>
            </span>
            {current.origin === "demo" && (
              <Tip
                content="Discard your changes to this demo project and restore its original data"
                side="bottom"
              >
                <Button
                  variant="secondary"
                  icon={<ArrowCounterClockwiseIcon size={16} />}
                  onClick={() => {
                    if (
                      confirm(
                        "Restore this demo project's original data? Your changes to it in this browser will be discarded (chats are kept)."
                      )
                    )
                      void local.reset();
                  }}
                >
                  <span className="hidden sm:inline">Reset data</span>
                </Button>
              </Tip>
            )}
          </div>
        </div>
      </header>

      <DemoBanner />

      <div className="flex flex-1 min-h-0">
        <Sidebar
          projects={projects}
          activeProjectId={projectId}
          chats={chats ?? []}
          activeChatId={activeChat}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed(!sidebarCollapsed)}
          onSelectProject={(id) => {
            closeSidebarOnMobile();
            navigate({ projectId: id });
          }}
          onSelectChat={(id) => {
            closeSidebarOnMobile();
            selectChat(id);
          }}
          onNewChat={newChat}
          onRenameChat={rename}
          onDeleteChat={remove}
          onImportProject={onImportProject}
          onDeleteProject={onDeleteProject}
        />

        <div
          className={`flex-1 min-w-0 ${showDashboard ? "hidden xl:flex" : "flex"}`}
        >
          {local.error ? (
            <div
              role="alert"
              className="flex-1 flex items-center justify-center p-6 text-sm text-red-600 dark:text-red-400"
            >
              {local.error}
            </div>
          ) : activeChat && state ? (
            <Chat
              key={`${projectId}:${activeChat}`}
              projectId={projectId}
              chatId={activeChat}
              project={state}
              onProjectChange={update}
              onFirstMessage={(text) =>
                rename(activeChat, text.replace(/\s+/g, " ").slice(0, 60))
              }
              commands={commands}
              workflows={workflows}
              showDebug={showDebug}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-kumo-inactive text-sm">
              Loading…
            </div>
          )}
        </div>

        <aside
          aria-label="Project dashboard"
          className={`min-w-0 flex-1 xl:flex-none xl:w-[400px] border-l border-kumo-line bg-kumo-base overflow-y-auto overflow-x-hidden ${showDashboard ? "block" : "hidden xl:block"}`}
        >
          <Dashboard state={state} />
        </aside>
      </div>

      {showSettings && (
        <SettingsPanel
          catalog={catalog}
          settings={settings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────

function Shell() {
  const demoApi = useApi<ProjectSummary[]>("/api/projects");
  const pluginsApi = useApi<PluginInfo[]>("/api/plugins");
  const imported = useImportedProjects();
  const [route, navigate] = useHashRoute();
  const [importing, setImporting] = useState(false);
  const error = demoApi.error ?? pluginsApi.error;

  // Settings overrides sync live from the SettingsAgent; the effective catalog
  // is resolved here exactly as the server resolves it.
  const [overrides, setOverrides] = useState<Overrides>();
  const settings = useAgent<SettingsAgent, Overrides>({
    agent: "SettingsAgent",
    name: SETTINGS_NAME,
    onStateUpdate: useCallback((s: Overrides) => setOverrides(s), [])
  });
  const catalog = useMemo(
    () =>
      pluginsApi.data &&
      resolveCatalog(pluginsApi.data, overrides ?? EMPTY_OVERRIDES),
    [pluginsApi.data, overrides]
  );
  const commands = useMemo(() => catalog && listCommands(catalog), [catalog]);

  const projects = useMemo<SidebarProject[] | undefined>(
    () =>
      demoApi.data &&
      imported.projects && [
        ...demoApi.data.map((p) => ({ ...p, origin: "demo" as ProjectOrigin })),
        ...imported.projects
      ],
    [demoApi.data, imported.projects]
  );
  const current =
    projects?.find((p) => p.id === route.projectId) ?? projects?.[0];

  useEffect(() => {
    if (current && current.id !== route.projectId)
      navigate({ projectId: current.id }, { replace: true });
  }, [current, route.projectId, navigate]);

  const onImported = useCallback(
    async (state: ProjectState) => {
      await storage.addImportedProject(state.project.id, state);
      await imported.refresh();
      setImporting(false);
      navigate({ projectId: state.project.id });
    },
    [imported, navigate]
  );

  const onDeleteProject = useCallback(
    async (id: string) => {
      await storage.deleteProject(id);
      await imported.refresh();
      navigate({});
    },
    [imported, navigate]
  );

  if (error) return <Centered>Couldn't load the app ({error}).</Centered>;
  if (!projects || !catalog || !commands) return <Centered>Loading…</Centered>;
  if (!current) return <Centered>No projects found.</Centered>;

  return (
    <>
      <Workspace
        key={current.id}
        projects={projects}
        project={current}
        catalog={catalog}
        commands={commands}
        settings={settings}
        chatId={route.chatId}
        navigate={navigate}
        onImportProject={() => setImporting(true)}
        onDeleteProject={onDeleteProject}
      />
      {importing && (
        <ImportProjectDialog
          existingIds={projects.map((p) => p.id)}
          onImport={onImported}
          onClose={() => setImporting(false)}
        />
      )}
    </>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center h-dvh text-kumo-inactive">
      {children}
    </div>
  );
}

export default function App() {
  return (
    <TooltipProvider>
      <Toasty>
        <Shell />
      </Toasty>
    </TooltipProvider>
  );
}
