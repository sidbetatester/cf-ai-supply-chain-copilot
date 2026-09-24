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
  TrashIcon
} from "@phosphor-icons/react";
import type { ChatMeta, ProjectSummary } from "../shared";

interface SidebarProps {
  projects: ProjectSummary[];
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
}

export function Sidebar(props: SidebarProps) {
  const { collapsed, onToggleCollapsed, onNewChat } = props;

  if (collapsed) {
    return (
      <nav className="hidden md:flex flex-col items-center gap-2 py-3 w-14 shrink-0 border-r border-kumo-line bg-kumo-base">
        <Button
          variant="ghost"
          shape="square"
          aria-label="Expand sidebar"
          icon={<SidebarSimpleIcon size={18} />}
          onClick={onToggleCollapsed}
        />
        <Button
          variant="ghost"
          shape="square"
          aria-label="New chat"
          icon={<PlusIcon size={18} />}
          onClick={onNewChat}
        />
      </nav>
    );
  }

  return (
    <nav className="flex flex-col w-72 shrink-0 border-r border-kumo-line bg-kumo-base">
      <div className="flex items-center justify-between px-3 py-3">
        <Text size="xs" variant="secondary" bold>
          PROJECTS
        </Text>
        <Button
          variant="ghost"
          shape="square"
          size="sm"
          aria-label="Collapse sidebar"
          icon={<SidebarSimpleIcon size={16} />}
          onClick={onToggleCollapsed}
        />
      </div>
      <ul className="flex-1 overflow-y-auto px-2 pb-3 space-y-0.5">
        {props.projects.map((p) => (
          <ProjectItem key={p.id} project={p} {...props} />
        ))}
      </ul>
    </nav>
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
  onDeleteChat
}: SidebarProps & { project: ProjectSummary }) {
  const active = project.id === activeProjectId;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelectProject(project.id)}
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-sm hover:bg-kumo-control ${active ? "text-kumo-default font-medium" : "text-kumo-subtle"}`}
      >
        {active ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
        <FolderIcon
          size={16}
          weight={active ? "fill" : "regular"}
          className="shrink-0"
        />
        <span className="truncate">{project.name}</span>
      </button>
      {active && (
        <ul className="ml-5 mt-0.5 space-y-0.5">
          <li>
            <button
              type="button"
              onClick={onNewChat}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm text-kumo-subtle hover:bg-kumo-control"
            >
              <PlusIcon size={14} /> New chat
            </button>
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
    <li className="group relative">
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={() => setEditing(true)}
        className={`w-full flex items-center gap-2 px-2 py-1.5 pr-14 rounded-lg text-left text-sm ${active ? "bg-kumo-control text-kumo-default" : "text-kumo-subtle hover:bg-kumo-control"}`}
      >
        <ChatCircleIcon size={14} className="shrink-0" />
        <span className="truncate">{chat.title}</span>
      </button>
      <div className="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:flex group-focus-within:flex">
        <Button
          variant="ghost"
          shape="square"
          size="xs"
          aria-label={`Rename ${chat.title}`}
          icon={<PencilSimpleIcon size={12} />}
          onClick={() => setEditing(true)}
        />
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
      </div>
    </li>
  );
}
