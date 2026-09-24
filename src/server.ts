import { routeAgentRequest } from "agents";
import { handleChat, handleUsage, handleWorkflowStep } from "./chat-api";
import { demoProject, listProjects } from "./data";
import { SETTINGS_NAME } from "./plugins/catalog";
import { BUNDLED_PLUGINS } from "./plugins/registry";

export { SettingsAgent } from "./agents/settings-agent";
export { UsageLimiter } from "./agents/usage-limiter";

const notFound = (what: string) =>
  new Response(`${what} not found`, { status: 404 });

/** Read-only bundled content: demo projects and the default plugin catalog. */
function handleGet(pathname: string): Response | undefined {
  if (pathname === "/api/projects") return Response.json(listProjects());
  if (pathname === "/api/plugins") return Response.json(BUNDLED_PLUGINS);
  const project = /^\/api\/projects\/([a-z0-9-]+)$/.exec(pathname);
  if (project) {
    const data = demoProject(project[1]);
    return data ? Response.json(data) : notFound("Project");
  }
  return undefined;
}

/** The only agent is the single Settings instance; everything else is stateless. */
function authorize(className: string, name: string): Response | void {
  if (className === "SettingsAgent" && name === SETTINGS_NAME) return;
  return notFound("Agent");
}

export default {
  async fetch(request: Request, env: Env) {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/api/usage")
      return handleUsage(request, env);
    if (request.method === "GET") {
      const response = handleGet(pathname);
      if (response) return response;
    }
    if (request.method === "POST" && pathname === "/api/chat")
      return handleChat(request, env);
    if (request.method === "POST" && pathname === "/api/workflow-step")
      return handleWorkflowStep(request, env);

    const guard = (_req: Request, lobby: { className: string; name: string }) =>
      authorize(lobby.className, lobby.name);
    return (
      (await routeAgentRequest(request, env, {
        onBeforeConnect: guard,
        onBeforeRequest: guard
      })) || notFound("Route")
    );
  }
} satisfies ExportedHandler<Env>;
