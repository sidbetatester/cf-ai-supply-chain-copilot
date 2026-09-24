import { getAgentByName, routeAgentRequest } from "agents";
import { listProjects, projectExists } from "./data";
import { listCommands, listPlugins } from "./plugins/registry";
import { parseChatAgentName } from "./shared";

export { ChatAgent } from "./agents/chat-agent";
export { ProjectAgent } from "./agents/project-agent";
export { PlaybookWorkflow } from "./workflows/playbook-workflow";

/** Read-only catalog endpoints (built from bundled data/ and plugins/). */
const API: Record<string, () => unknown> = {
  "/api/projects": listProjects,
  "/api/plugins": listPlugins,
  "/api/commands": listCommands
};

const notFound = (what: string) =>
  new Response(`${what} not found`, { status: 404 });

/** Only allow connections to projects defined in data/ and chats registered with them. */
async function authorize(
  env: Env,
  className: string,
  name: string
): Promise<Response | void> {
  if (className === "ProjectAgent") {
    if (!projectExists(name)) return notFound("Project");
    return;
  }
  if (className === "ChatAgent") {
    const { projectId, chatId } = parseChatAgentName(name);
    if (!projectExists(projectId)) return notFound("Project");
    const project = await getAgentByName(env.ProjectAgent, projectId);
    if (!(await project.hasChat(chatId))) return notFound("Chat");
    return;
  }
  return notFound("Agent");
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname in API) {
      return Response.json(API[url.pathname]());
    }

    const guard = (_req: Request, lobby: { className: string; name: string }) =>
      authorize(env, lobby.className, lobby.name).catch(() =>
        notFound("Agent")
      );

    return (
      (await routeAgentRequest(request, env, {
        onBeforeConnect: guard,
        onBeforeRequest: guard
      })) || notFound("Route")
    );
  }
} satisfies ExportedHandler<Env>;
