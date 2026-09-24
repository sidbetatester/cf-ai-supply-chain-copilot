import { useCallback, useEffect, useMemo, useState } from "react";
import { useAgent } from "agents/react";
import { Badge, Button, Switch, Text, TooltipProvider } from "@cloudflare/kumo";
import { Toasty, useKumoToastManager } from "@cloudflare/kumo/components/toast";
import {
  ArrowCounterClockwiseIcon,
  BugIcon,
  ChartBarIcon,
  CircleIcon,
  GearSixIcon,
  ListIcon,
  MoonIcon,
  SunIcon,
  TruckIcon
} from "@phosphor-icons/react";
import type { ProjectAgent } from "./agents/project-agent";
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
import type { SettingsAgent } from "./agents/settings-agent";
import {
  sha256Hex,
  type ChatMeta,
  type ProjectState,
  type ProjectSummary
} from "./shared";
import { Chat } from "./components/chat";
import { Dashboard } from "./components/dashboard";
import { Sidebar } from "./components/sidebar";
import { Tip } from "./components/tip";
import { SettingsPanel, type SettingsConnection } from "./components/settings";

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

// ── Chat ownership: a random per-browser token (only its hash is shared) ──

const OWNER_TOKEN_KEY = "chatOwnerToken";

function useOwnerToken() {
  const [token] = useState(() => {
    try {
      const stored = localStorage.getItem(OWNER_TOKEN_KEY);
      if (stored) return stored;
    } catch {
      // Storage blocked: the token lasts for this page load only.
    }
    const created = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll(
      "-",
      ""
    );
    try {
      localStorage.setItem(OWNER_TOKEN_KEY, created);
    } catch {
      // As above.
    }
    return created;
  });
  const [hash, setHash] = useState<string>();
  useEffect(() => {
    sha256Hex(token).then(setHash);
  }, [token]);
  return { token, hash };
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

// ── Workspace: one connected project ──────────────────────────────────

function Workspace({
  projects,
  catalog,
  commands,
  settings,
  adminKey,
  onAdminKey,
  projectId,
  chatId,
  navigate
}: {
  projects: ProjectSummary[];
  catalog: Catalog;
  commands: CommandInfo[];
  settings: SettingsConnection;
  /** Set after unlocking Settings; enables admin-only project actions. */
  adminKey: string | undefined;
  onAdminKey: (key: string) => void;
  projectId: string;
  chatId: string | undefined;
  navigate: ReturnType<typeof useHashRoute>[1];
}) {
  const toasts = useKumoToastManager();
  const [state, setState] = useState<ProjectState>();
  const [chatConnected, setChatConnected] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false); // small screens
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistentFlag(
    "sidebarCollapsed",
    window.innerWidth < 768
  );

  const project = useAgent<ProjectAgent, ProjectState>({
    agent: "ProjectAgent",
    name: projectId,
    onStateUpdate: useCallback((s: ProjectState) => setState(s), []),
    onMessage: useCallback(
      (message: MessageEvent) => {
        try {
          const data = JSON.parse(String(message.data));
          if (data.type === "reminder") {
            toasts.add({
              title: "⏰ Reminder",
              description: data.description,
              timeout: 0
            });
          }
        } catch {
          // Not one of our events.
        }
      },
      [toasts]
    )
  });

  // On small screens the sidebar is a drawer: close it once a choice is made.
  const closeSidebarOnMobile = useCallback(() => {
    if (window.matchMedia("(max-width: 767px)").matches)
      setSidebarCollapsed(true);
  }, [setSidebarCollapsed]);

  const owner = useOwnerToken();
  const canManageChat = useCallback(
    (chat: ChatMeta) => !chat.ownerHash || chat.ownerHash === owner.hash,
    [owner.hash]
  );
  /** Run a project action, surfacing failures (e.g. limits, permissions) as a toast. */
  const attempt = useCallback(
    (title: string, action: () => Promise<unknown>) =>
      action().catch((e: unknown) =>
        toasts.add({
          title,
          description: e instanceof Error ? e.message : String(e)
        })
      ),
    [toasts]
  );

  const selectChat = useCallback(
    (id: string, opts?: { replace?: boolean }) =>
      navigate({ projectId, chatId: id }, opts),
    [navigate, projectId]
  );

  const newChat = useCallback(
    () =>
      attempt("Couldn't create a chat", async () => {
        const chat = await project.stub.createChat(owner.token);
        selectChat(chat.id);
      }),
    [attempt, project, owner.token, selectChat]
  );

  // Keep the route pointing at a real chat: open the newest, or create one.
  const chats = state?.chats;
  useEffect(() => {
    if (!chats || (chatId && chats.some((c) => c.id === chatId))) return;
    if (chats.length > 0) selectChat(chats[0].id, { replace: true });
    else
      attempt("Couldn't create a chat", async () => {
        const chat = await project.stub.createChat(owner.token);
        selectChat(chat.id, { replace: true });
      });
  }, [chats, chatId, project, owner.token, attempt, selectChat]);

  const activeChat =
    chatId && chats?.some((c) => c.id === chatId) ? chatId : undefined;

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
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
            <output
              className="hidden sm:flex items-center gap-1.5"
              aria-live="polite"
            >
              <CircleIcon
                size={8}
                weight="fill"
                className={
                  chatConnected ? "text-kumo-success" : "text-kumo-danger"
                }
              />
              <Text size="xs" variant="secondary">
                {chatConnected ? "Connected" : "Connecting…"}
              </Text>
            </output>
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
            <Tip
              content={
                adminKey
                  ? "Reset this project's data to its source files in data/"
                  : "Admin only: unlock Settings with the admin key to reload project data"
              }
              side="bottom"
            >
              <Button
                variant="secondary"
                icon={<ArrowCounterClockwiseIcon size={16} />}
                disabled={!adminKey}
                onClick={() => {
                  if (
                    adminKey &&
                    confirm(
                      "Reload this project's data from its source files? Changes made in chats will be discarded."
                    )
                  ) {
                    attempt("Couldn't reload data", () =>
                      project.stub.resetProject(adminKey)
                    );
                  }
                }}
              >
                <span className="hidden sm:inline">Reload data</span>
              </Button>
            </Tip>
          </div>
        </div>
      </header>

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
          canManageChat={canManageChat}
          onRenameChat={(id, title) =>
            attempt("Couldn't rename the chat", () =>
              project.stub.renameChat(id, title, owner.token)
            )
          }
          onDeleteChat={(id) =>
            attempt("Couldn't delete the chat", () =>
              project.stub.deleteChat(id, owner.token)
            )
          }
        />

        <div
          className={`flex-1 min-w-0 ${showDashboard ? "hidden xl:flex" : "flex"}`}
        >
          {activeChat ? (
            <Chat
              key={activeChat}
              projectId={projectId}
              chatId={activeChat}
              commands={commands}
              showDebug={showDebug}
              onConnectionChange={setChatConnected}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-kumo-inactive text-sm">
              Loading chat…
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
          onUnlocked={onAdminKey}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────

function Shell() {
  const projectsApi = useApi<ProjectSummary[]>("/api/projects");
  const pluginsApi = useApi<PluginInfo[]>("/api/plugins");
  const [route, navigate] = useHashRoute();
  const projects = projectsApi.data;
  const error = projectsApi.error ?? pluginsApi.error;

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
  // Held in memory only after a successful Settings unlock (never stored).
  const [adminKey, setAdminKey] = useState<string>();

  const projectId =
    projects?.find((p) => p.id === route.projectId)?.id ?? projects?.[0]?.id;

  useEffect(() => {
    if (projectId && projectId !== route.projectId)
      navigate({ projectId }, { replace: true });
  }, [projectId, route.projectId, navigate]);

  if (error) return <Centered>Couldn't load the app ({error}).</Centered>;
  if (!projects || !catalog || !commands) return <Centered>Loading…</Centered>;
  if (!projectId)
    return (
      <Centered>
        No projects found. Add data/projects/&lt;id&gt;.json to get started.
      </Centered>
    );

  return (
    <Workspace
      key={projectId}
      projects={projects}
      catalog={catalog}
      commands={commands}
      settings={settings}
      adminKey={adminKey}
      onAdminKey={setAdminKey}
      projectId={projectId}
      chatId={route.chatId}
      navigate={navigate}
    />
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center h-screen text-kumo-inactive">
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
