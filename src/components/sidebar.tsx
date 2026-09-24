import { useState } from "react";
import { Button, Text } from "@cloudflare/kumo";
import {
  CaretDownIcon,
  CaretRightIcon,
  ChatCircleIcon,
  FolderIcon,
  PencilSimpleIcon,
  PlusIcon,
  SidebarSimpleIcon,
  TrashIcon,
  UploadSimpleIcon
} from "@phosphor-icons/react";
import type { ProjectOrigin } from "../browser/hooks";
import type { ChatMeta, ProjectSummary } from "../shared";
import { Tip } from "./tip";

/** A demo project (from the server) or one imported into this browser. */
export type SidebarProject = ProjectSummary & { origin: ProjectOrigin };

interface SidebarProps {
  projects: SidebarProject[];
  activeProjectId: string;
  chats: ChatMeta[];
  activeChatId: string | undefined;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelectProject: (id: string) => void;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  onRenameChat: (id: string, title: string) => void;
  onDeleteChat: (id: string) => void;
  onImportProject: () => void;
  onDeleteProject: (id: string) => void;
}

export function Sidebar(props: SidebarProps) {
  const { collapsed, onToggleCollapsed, onNewChat } = props;

  if (collapsed) {
    return (
      <nav
        aria-label="Projects and chats"
        className="hidden md:flex flex-col items-center gap-2 py-3 w-14 shrink-0 border-r border-kumo-line bg-kumo-base"
      >
        <Tip content="Show projects and chats" side="right">
          <Button
            variant="ghost"
            shape="square"
            aria-label="Expand sidebar"
            icon={<SidebarSimpleIcon size={18} />}
            onClick={onToggleCollapsed}
          />
        </Tip>
        <Tip content="Start a new chat in this project" side="right">
          <Button
            variant="ghost"
            shape="square"
            aria-label="New chat"
            icon={<PlusIcon size={18} />}
            onClick={onNewChat}
          />
        </Tip>
      </nav>
    );
  }

  return (
    <>
      {/* Small screens: the sidebar is a drawer over the chat. */}
      <button
        type="button"
        aria-label="Close sidebar"
        className="md:hidden fixed inset-0 z-30 bg-black/30"
        onClick={onToggleCollapsed}
      />
      <nav
        aria-label="Projects and chats"
        className="fixed inset-y-0 left-0 z-40 md:static md:z-auto flex flex-col w-72 max-w-[85vw] md:w-64 shrink-0 border-r border-kumo-line bg-kumo-base"
      >
        <div className="flex items-center justify-between px-3 py-3">
          <Text size="xs" variant="secondary" bold>
            PROJECTS
          </Text>
          <Tip content="Hide the sidebar" side="right">
            <Button
              variant="ghost"
              shape="square"
              size="sm"
              aria-label="Collapse sidebar"
              icon={<SidebarSimpleIcon size={16} />}
              onClick={onToggleCollapsed}
            />
          </Tip>
        </div>
        <ul className="flex-1 overflow-y-auto overflow-x-hidden px-2 pb-3 space-y-0.5">
          {props.projects.map((p) => (
            <ProjectItem key={p.id} project={p} {...props} />
          ))}
        </ul>
        <div className="border-t border-kumo-line p-2">
          <Tip
            content="Add your own project from JSON and CSV files (saved in this browser only)"
            side="right"
            block
          >
            <button
              type="button"
              onClick={props.onImportProject}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm text-kumo-subtle hover:bg-kumo-control"
            >
              <UploadSimpleIcon size={14} /> Import project
            </button>
          </Tip>
        </div>
      </nav>
    </>
  );
}

function ProjectItem({
  project,
  activeProjectId,
  chats,
  activeChatId,
  onSelectProject,
  onSelectChat,
  onNewChat,
  onRenameChat,
  onDeleteChat,
  onDeleteProject
}: SidebarProps & { project: SidebarProject }) {
  const active = project.id === activeProjectId;
  const imported = project.origin === "imported";
  return (
    <li className="group/project relative min-w-0">
      <Tip
        content={`${project.name} · ${project.site}${imported ? " · imported, in this browser only" : " · demo project"}`}
        side="right"
        block
      >
        <button
          type="button"
          onClick={() => onSelectProject(project.id)}
          aria-current={active ? "page" : undefined}
          className={`w-full min-w-0 flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-sm hover:bg-kumo-control ${active ? "text-kumo-default font-medium" : "text-kumo-subtle"}`}
        >
          {active ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
          <FolderIcon
            size={16}
            weight={active ? "fill" : "regular"}
            className="shrink-0"
          />
          <span className="truncate">{project.name}</span>
          {imported && (
            <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-kumo-subtle pr-6">
              local
            </span>
          )}
        </button>
      </Tip>
      {imported && (
        <div className="absolute right-1 top-1 hidden group-hover/project:flex group-focus-within/project:flex">
          <Tip content="Delete this imported project and its chats from this browser">
            <Button
              variant="ghost"
              shape="square"
              size="xs"
              aria-label={`Delete project ${project.name}`}
              icon={<TrashIcon size={12} />}
              onClick={() => {
                if (
                  confirm(
                    `Delete "${project.name}" and all its chats from this browser? This can't be undone.`
                  )
                )
                  onDeleteProject(project.id);
              }}
            />
          </Tip>
        </div>
      )}
      {active && (
        <ul className="ml-5 mt-0.5 space-y-0.5">
          <li>
            <Tip content="Start a new chat in this project" side="right" block>
              <button
                type="button"
                onClick={onNewChat}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm text-kumo-subtle hover:bg-kumo-control"
              >
                <PlusIcon size={14} /> New chat
              </button>
            </Tip>
          </li>
          {chats.map((chat) => (
            <ChatItem
              key={chat.id}
              chat={chat}
              active={chat.id === activeChatId}
              onSelect={() => onSelectChat(chat.id)}
              onRename={(title) => onRenameChat(chat.id, title)}
              onDelete={() => onDeleteChat(chat.id)}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function ChatItem({
  chat,
  active,
  onSelect,
  onRename,
  onDelete
}: {
  chat: ChatMeta;
  active: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <li>
        <input
          ref={(el) => el?.select()}
          defaultValue={chat.title}
          aria-label="Chat title"
          maxLength={80}
          className="w-full px-2 py-1 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-ring"
          onBlur={(e) => {
            onRename(e.currentTarget.value);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      </li>
    );
  }

  return (
    <li className="group relative min-w-0">
      <Tip
        content={`${chat.title} · double-click to rename`}
        side="right"
        block
      >
        <button
          type="button"
          onClick={onSelect}
          onDoubleClick={() => setEditing(true)}
          aria-current={active ? "page" : undefined}
          className={`w-full min-w-0 flex items-center gap-2 px-2 py-1.5 pr-14 rounded-lg text-left text-sm ${active ? "bg-kumo-control text-kumo-default" : "text-kumo-subtle hover:bg-kumo-control"}`}
        >
          <ChatCircleIcon size={14} className="shrink-0" />
          <span className="truncate">{chat.title}</span>
        </button>
      </Tip>
      <div className="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:flex group-focus-within:flex">
        <Tip content="Rename this chat">
          <Button
            variant="ghost"
            shape="square"
            size="xs"
            aria-label={`Rename ${chat.title}`}
            icon={<PencilSimpleIcon size={12} />}
            onClick={() => setEditing(true)}
          />
        </Tip>
        <Tip content="Delete this chat and its messages">
          <Button
            variant="ghost"
            shape="square"
            size="xs"
            aria-label={`Delete ${chat.title}`}
            icon={<TrashIcon size={12} />}
            onClick={() => {
              if (
                confirm(
                  `Delete "${chat.title}"? Its messages will be permanently removed.`
                )
              )
                onDelete();
            }}
          />
        </Tip>
      </div>
    </li>
  );
}
