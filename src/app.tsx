import { useCallback, useEffect, useMemo, useState } from "react";
import { useAgent } from "agents/react";
import { Badge, Button, Switch, Text } from "@cloudflare/kumo";
import { Toasty, useKumoToastManager } from "@cloudflare/kumo/components/toast";
import {
  ArrowCounterClockwiseIcon,
  BugIcon,
  ChartBarIcon,
  CircleIcon,
  ListIcon,
  MoonIcon,
  SunIcon,
  TruckIcon
} from "@phosphor-icons/react";
import type { ProjectAgent } from "./agents/project-agent";
import type { PluginInfo, PromptInfo } from "./plugins/registry";
import type { ProjectState, ProjectSummary } from "./shared";
import { Chat } from "./components/chat";
import { Dashboard } from "./components/dashboard";
import { Sidebar } from "./components/sidebar";

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
    <Button
      variant="secondary"
      shape="square"
      icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      onClick={toggle}
      aria-label="Toggle theme"
    />
  );
}

// ── Workspace: one connected project ──────────────────────────────────

function Workspace({
  projects,
  commands,
  projectId,
  chatId,
  navigate
}: {
  projects: ProjectSummary[];
  commands: PromptInfo[];
  projectId: string;
  chatId: string | undefined;
  navigate: ReturnType<typeof useHashRoute>[1];
}) {
  const toasts = useKumoToastManager();
  const [state, setState] = useState<ProjectState>();
  const [chatConnected, setChatConnected] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false); // small screens
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

  const selectChat = useCallback(
    (id: string, opts?: { replace?: boolean }) =>
      navigate({ projectId, chatId: id }, opts),
    [navigate, projectId]
  );

  const newChat = useCallback(async () => {
    const chat = await project.stub.createChat();
    selectChat(chat.id);
  }, [project, selectChat]);

  // Keep the route pointing at a real chat: open the newest, or create one.
  const chats = state?.chats;
  useEffect(() => {
    if (!chats || (chatId && chats.some((c) => c.id === chatId))) return;
    if (chats.length > 0) selectChat(chats[0].id, { replace: true });
    else
      project.stub
        .createChat()
        .then((c) => selectChat(c.id, { replace: true }));
  }, [chats, chatId, project, selectChat]);

  const activeChat =
    chatId && chats?.some((c) => c.id === chatId) ? chatId : undefined;

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      <header className="px-4 py-3 bg-kumo-base border-b border-kumo-line">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Button
              variant="ghost"
              shape="square"
              className="md:hidden"
              aria-label="Toggle sidebar"
              icon={<ListIcon size={18} />}
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            />
            <h1 className="text-lg font-semibold text-kumo-default truncate">
              <TruckIcon
                size={20}
                weight="duotone"
                className="inline mr-2 -mt-0.5 text-kumo-brand"
              />
              Supply Chain Copilot
            </h1>
            <Badge variant="secondary" className="hidden sm:inline-flex">
              Llama 3.3 · Workers AI
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
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
            </div>
            <div className="hidden sm:flex items-center gap-1.5">
              <BugIcon size={14} className="text-kumo-inactive" />
              <Switch
                checked={showDebug}
                onCheckedChange={setShowDebug}
                size="sm"
                aria-label="Toggle debug mode"
              />
            </div>
            <ThemeToggle />
            <Button
              variant="secondary"
              shape="square"
              className="lg:hidden"
              aria-label="Toggle dashboard"
              icon={<ChartBarIcon size={16} />}
              onClick={() => setShowDashboard((v) => !v)}
            />
            <Button
              variant="secondary"
              icon={<ArrowCounterClockwiseIcon size={16} />}
              onClick={() => {
                if (
                  confirm(
                    "Reload this project's data from its source files? Changes made in chats will be discarded."
                  )
                ) {
                  project.stub.resetProject();
                }
              }}
            >
              <span className="hidden sm:inline">Reload data</span>
            </Button>
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
          onSelectProject={(id) => navigate({ projectId: id })}
          onSelectChat={selectChat}
          onNewChat={newChat}
          onRenameChat={(id, title) => project.stub.renameChat(id, title)}
          onDeleteChat={(id) => project.stub.deleteChat(id)}
        />

        <div
          className={`flex-1 min-w-0 ${showDashboard ? "hidden lg:flex" : "flex"}`}
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
          className={`w-full lg:w-[440px] shrink-0 border-l border-kumo-line bg-kumo-base overflow-y-auto ${showDashboard ? "block" : "hidden lg:block"}`}
        >
          <Dashboard state={state} />
        </aside>
      </div>
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
  const commands = useMemo(
    () => pluginsApi.data?.flatMap((p) => p.prompts) ?? [],
    [pluginsApi.data]
  );

  const projectId =
    projects?.find((p) => p.id === route.projectId)?.id ?? projects?.[0]?.id;

  useEffect(() => {
    if (projectId && projectId !== route.projectId)
      navigate({ projectId }, { replace: true });
  }, [projectId, route.projectId, navigate]);

  if (error) return <Centered>Couldn't load the app ({error}).</Centered>;
  if (!projects || !pluginsApi.data) return <Centered>Loading…</Centered>;
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
      commands={commands}
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
    <Toasty>
      <Shell />
    </Toasty>
  );
}
