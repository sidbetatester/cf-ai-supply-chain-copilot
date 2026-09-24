import { useCallback, useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type UIMessage
} from "ai";
import { Badge, Button, Empty, InputArea } from "@cloudflare/kumo";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import {
  BrainIcon,
  CaretDownIcon,
  MicrophoneIcon,
  PaperPlaneRightIcon,
  StopIcon,
  TruckIcon
} from "@phosphor-icons/react";
import { loadMessages, saveMessages } from "../browser/storage";
import type { AppUIMessage } from "../chat-api";
import type { CommandInfo, EffectiveWorkflow } from "../plugins/catalog";
import { parseSlashCommand, type ProjectState } from "../shared";
import {
  activeCommand,
  CommandMenu,
  commandText,
  useCommandMenu
} from "./command-menu";
import { Tip } from "./tip";
import { ToolPartView } from "./tool-part";

/** Allow only https and mailto links (and in-page anchors) in rendered markdown. */
const safeUrl = (url: string) =>
  /^(https:|mailto:|#)/i.test(url.trim()) ? url : null;

// ── Voice input (browser Web Speech API, no backend needed) ──────────

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: (e: {
    results: ArrayLike<
      ArrayLike<{ transcript: string }> & { isFinal: boolean }
    >;
  }) => void;
  onend: () => void;
  onerror: (e: { error: string }) => void;
  start: () => void;
  stop: () => void;
};

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition) as
    | (new () => SpeechRecognitionLike)
    | undefined;
}

/** Back-to-back sessions with no speech before dictation turns itself off. */
const MAX_EMPTY_SESSIONS = 3;

const joinText = (a: string, b: string) => (a && b ? `${a} ${b}` : a || b);

/**
 * Dictation that appends to whatever is already typed. Recognition runs
 * continuously; if the browser ends the session after a silence, it restarts
 * (keeping everything so far) until the user turns the mic off.
 */
function useVoiceInput(getText: () => string, setText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const wantRef = useRef(false);
  const SpeechRecognition = getSpeechRecognition();

  const toggle = useCallback(() => {
    if (!SpeechRecognition) return;
    if (wantRef.current) {
      wantRef.current = false;
      recognitionRef.current?.stop();
      return;
    }
    wantRef.current = true;
    setListening(true);
    // Stop if the browser keeps ending sessions without hearing anything.
    let emptySessions = 0;

    const startSession = () => {
      const base = getText().trimEnd();
      let heard = false;
      const rec = new SpeechRecognition();
      rec.lang = navigator.language || "en-US";
      rec.interimResults = true;
      rec.continuous = true;
      rec.onresult = (e) => {
        heard = true;
        const spoken = Array.from(e.results)
          .map((r) => r[0].transcript.trim())
          .filter(Boolean)
          .join(" ");
        setText(joinText(base, spoken));
      };
      rec.onerror = (e) => {
        // Permission or hardware problems stop dictation; silence just restarts.
        if (e.error !== "no-speech" && e.error !== "aborted")
          wantRef.current = false;
      };
      rec.onend = () => {
        emptySessions = heard ? 0 : emptySessions + 1;
        if (wantRef.current && emptySessions < MAX_EMPTY_SESSIONS)
          startSession();
        else {
          wantRef.current = false;
          setListening(false);
        }
      };
      recognitionRef.current = rec;
      rec.start();
    };
    startSession();
  }, [SpeechRecognition, getText, setText]);

  useEffect(
    () => () => {
      wantRef.current = false;
      recognitionRef.current?.stop();
    },
    []
  );

  return { supported: !!SpeechRecognition, listening, toggle };
}
// ── Chat ──────────────────────────────────────────────────────────────

interface ChatProps {
  projectId: string;
  chatId: string;
  /** This browser's copy of the project; sent with every request. */
  project: ProjectState;
  onProjectChange: (state: ProjectState) => void;
  /** Called with the first message so the chat can be titled. */
  onFirstMessage: (text: string) => void;
  commands: CommandInfo[];
  workflows: EffectiveWorkflow[];
  showDebug: boolean;
}

/**
 * Latest project (and change handler) for each open chat. Read when a request
 * is sent or a tool update arrives, outside React rendering.
 */
const liveChats = new Map<
  string,
  { project: ProjectState; onProjectChange: (state: ProjectState) => void }
>();
const transports = new Map<string, DefaultChatTransport<AppUIMessage>>();

/** One transport per chat; every request carries this browser's copy of the project. */
function transportFor(key: string) {
  let transport = transports.get(key);
  if (!transport) {
    transport = new DefaultChatTransport<AppUIMessage>({
      api: "/api/chat",
      body: () => ({ project: liveChats.get(key)?.project })
    });
    transports.set(key, transport);
  }
  return transport;
}
const textMessage = (
  role: "user" | "assistant",
  text: string
): AppUIMessage => ({
  id: crypto.randomUUID(),
  role,
  parts: [{ type: "text", text }]
});

const errorText = async (response: Response) => {
  try {
    return (
      ((await response.json()) as { error?: string }).error ??
      `HTTP ${response.status}`
    );
  } catch {
    return `HTTP ${response.status}`;
  }
};

/** Loads the chat's saved messages from this browser, then shows it. */
export function Chat(props: ChatProps) {
  const [initial, setInitial] = useState<AppUIMessage[]>();
  useEffect(() => {
    let cancelled = false;
    loadMessages<AppUIMessage>(props.projectId, props.chatId).then(
      (m) => !cancelled && setInitial(m)
    );
    return () => {
      cancelled = true;
    };
  }, [props.projectId, props.chatId]);
  if (!initial)
    return (
      <div className="flex-1 flex items-center justify-center text-kumo-inactive text-sm">
        Loading chat…
      </div>
    );
  return <ChatView {...props} initialMessages={initial} />;
}

function ChatView({
  projectId,
  chatId,
  project,
  onProjectChange,
  onFirstMessage,
  commands,
  workflows,
  showDebug,
  initialMessages
}: ChatProps & { initialMessages: AppUIMessage[] }) {
  const [input, setInput] = useState("");
  const [runningWorkflow, setRunningWorkflow] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Requests and tool updates read the latest project from the registry.
  const liveKey = `${projectId}:${chatId}`;
  useEffect(() => {
    liveChats.set(liveKey, { project, onProjectChange });
  }, [liveKey, project, onProjectChange]);
  useEffect(() => () => void liveChats.delete(liveKey), [liveKey]);
  const [transport] = useState(() => transportFor(liveKey));
  const live = useCallback(() => liveChats.get(liveKey), [liveKey]);

  const {
    messages,
    setMessages,
    sendMessage,
    addToolApprovalResponse,
    stop,
    status,
    error,
    clearError,
    regenerate
  } = useChat<AppUIMessage>({
    id: `${projectId}:${chatId}`,
    messages: initialMessages,
    transport,
    // Project changes made by tools arrive as transient data parts.
    onData: (part) => {
      if (part.type === "data-project") {
        const current = live();
        if (current) {
          current.project = part.data;
          current.onProjectChange(part.data);
        }
      }
    },
    // After an approval decision, send it back so the agent can continue.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses
  });

  const busy =
    status === "streaming" || status === "submitted" || runningWorkflow;

  // Save the conversation in this browser whenever a turn settles.
  useEffect(() => {
    if (status === "ready" || status === "error")
      void saveMessages(projectId, chatId, messages);
  }, [messages, status, projectId, chatId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!busy) textareaRef.current?.focus();
  }, [busy]);

  /** Run a workflow's steps in order; each step's result is posted as it finishes. */
  const runWorkflow = useCallback(
    async (workflow: EffectiveWorkflow, args: string, commandText: string) => {
      setRunningWorkflow(true);
      const steps = workflow.steps;
      let history = [
        ...messages,
        textMessage("user", commandText),
        textMessage(
          "assistant",
          `▶️ Running workflow **/${workflow.name}** (${steps.length} step${steps.length === 1 ? "" : "s"}):\n\n${steps.map((s, i) => `${i + 1}. ${s.name}`).join("\n")}`
        )
      ];
      setMessages(history);
      const previous: { name: string; text: string }[] = [];
      try {
        for (let step = 0; step < steps.length; step++) {
          const response = await fetch("/api/workflow-step", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              project: live()?.project,
              workflow: workflow.name,
              step,
              args,
              previous
            })
          });
          if (!response.ok) throw new Error(await errorText(response));
          const result = (await response.json()) as {
            name: string;
            text: string;
            project: ProjectState;
          };
          const current = live();
          if (current) current.project = result.project;
          current?.onProjectChange(result.project);
          previous.push({ name: result.name, text: result.text });
          history = [
            ...history,
            textMessage(
              "assistant",
              `**Step ${step + 1}/${steps.length} · ${result.name}**\n\n${result.text}`
            )
          ];
          setMessages(history);
        }
        history = [
          ...history,
          textMessage(
            "assistant",
            `✅ Workflow **/${workflow.name}** complete.`
          )
        ];
      } catch (e) {
        history = [
          ...history,
          textMessage(
            "assistant",
            `⚠️ Workflow stopped: ${e instanceof Error ? e.message : String(e)}`
          )
        ];
      }
      setMessages(history);
      await saveMessages(projectId, chatId, history);
      setRunningWorkflow(false);
    },
    [messages, setMessages, projectId, chatId, live]
  );

  const sendText = useCallback(
    (text: string) => {
      if (messages.length === 0) onFirstMessage(text);
      clearError();
      const command = parseSlashCommand(text);
      const workflow =
        command && workflows.find((w) => w.name === command.name);
      if (workflow) {
        if (!workflow.enabled || workflow.problems.length > 0) {
          setMessages([
            ...messages,
            textMessage("user", text),
            textMessage(
              "assistant",
              workflow.enabled
                ? `Workflow **/${workflow.name}** can't run as configured:\n\n${workflow.problems.map((p) => `- ${p}`).join("\n")}`
                : `Workflow **/${workflow.name}** is turned off in Settings.`
            )
          ]);
          return;
        }
        void runWorkflow(workflow, command.args, text);
        return;
      }
      void sendMessage({ role: "user", parts: [{ type: "text", text }] });
    },
    [
      messages,
      onFirstMessage,
      clearError,
      workflows,
      setMessages,
      runWorkflow,
      sendMessage
    ]
  );

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    sendText(text);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [input, busy, sendText]);

  const inputRef = useRef(input);
  useEffect(() => {
    inputRef.current = input;
  }, [input]);
  const voice = useVoiceInput(
    useCallback(() => inputRef.current, []),
    setInput
  );

  /** Put a command in the input, or run it right away if it takes no arguments. */
  const pickCommand = useCallback(
    (command: CommandInfo, submit: boolean) => {
      if (submit) {
        setInput("");
        sendText(`/${command.name}`);
      } else {
        setInput(commandText(command));
        textareaRef.current?.focus();
      }
    },
    [sendText]
  );
  const menu = useCommandMenu(input, commands, pickCommand);
  const hint = activeCommand(input, commands);
  const connected = true;
  const isStreaming = busy;
  return (
    <main className="flex-1 flex flex-col min-w-0">
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        <div className="max-w-3xl mx-auto px-4 sm:px-5 py-6 space-y-5 min-w-0">
          {messages.length === 0 && (
            <Empty
              icon={<TruckIcon size={32} />}
              title="Your program copilot"
              description="Ask anything about the project, paste meeting notes, or type / for commands. Changes appear live on the dashboard."
              contents={
                <ul className="w-full max-w-xl mx-auto space-y-2 text-left">
                  {commands.map((command) => (
                    <li key={command.name}>
                      <Tip
                        content={
                          command.argumentHint
                            ? `Insert /${command.name} so you can add ${command.argumentHint}`
                            : `Run /${command.name} now`
                        }
                        block
                      >
                        <button
                          type="button"
                          disabled={isStreaming || !connected}
                          onClick={() =>
                            pickCommand(command, !command.argumentHint)
                          }
                          className="w-full min-w-0 rounded-xl border border-kumo-line bg-kumo-base px-3 py-2 text-left text-sm hover:bg-kumo-control disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <span className="flex items-center gap-2 font-mono text-kumo-default">
                            /{command.name}
                            {command.kind === "workflow" && (
                              <Badge variant="secondary">workflow</Badge>
                            )}
                          </span>
                          <span className="block text-kumo-subtle break-words">
                            {command.description}
                          </span>
                        </button>
                      </Tip>
                    </li>
                  ))}
                </ul>
              }
            />
          )}

          {messages.map((message: UIMessage, index: number) => (
            <MessageView
              key={message.id}
              message={message}
              showDebug={showDebug}
              isAnimating={isStreaming && index === messages.length - 1}
              addToolApprovalResponse={addToolApprovalResponse}
            />
          ))}

          {error && !busy && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 rounded-xl px-4 py-3 text-sm bg-red-500/10 text-red-700 dark:text-red-300 ring-1 ring-red-500/20"
            >
              <span className="flex-1 min-w-0 break-words">
                {error.message || "Something went wrong."}
              </span>
              <Tip content="Send the last message again">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => regenerate()}
                >
                  Retry
                </Button>
              </Tip>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="border-t border-kumo-line bg-kumo-base">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="relative max-w-3xl mx-auto px-4 sm:px-5 py-3 sm:py-4"
        >
          <CommandMenu menu={menu} onSelect={(c) => pickCommand(c, false)} />
          {hint && (
            <div className="mb-2 text-xs text-kumo-subtle">
              <span className="font-mono text-kumo-default">/{hint.name}</span>
              {hint.argumentHint && (
                <span className="font-mono"> {hint.argumentHint}</span>
              )}{" "}
              · {hint.description}
            </div>
          )}
          <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
            {voice.supported && (
              <Tip
                content={
                  voice.listening
                    ? "Stop dictating"
                    : "Dictate your message (speech to text)"
                }
              >
                <Button
                  type="button"
                  variant={voice.listening ? "primary" : "ghost"}
                  shape="square"
                  aria-label={
                    voice.listening ? "Stop voice input" : "Start voice input"
                  }
                  icon={
                    <MicrophoneIcon
                      size={18}
                      className={voice.listening ? "animate-pulse" : ""}
                    />
                  }
                  onClick={voice.toggle}
                  disabled={!connected || isStreaming}
                  className="mb-0.5"
                />
              </Tip>
            )}
            <InputArea
              ref={textareaRef}
              value={input}
              onValueChange={setInput}
              onKeyDown={(e) => {
                if (menu.onKeyDown(e)) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              onInput={(e) => {
                // Grow with the text up to max-h-40, then scroll.
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${el.scrollHeight}px`;
                el.style.overflowY =
                  el.scrollHeight > el.clientHeight ? "auto" : "hidden";
              }}
              placeholder={
                voice.listening ? "Listening…" : "Message or /command"
              }
              disabled={!connected || isStreaming}
              rows={1}
              className="flex-1 min-w-0 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none! resize-none max-h-40 overflow-y-hidden"
            />
            {isStreaming ? (
              <Tip content="Stop the response">
                <Button
                  type="button"
                  variant="secondary"
                  shape="square"
                  aria-label="Stop generation"
                  icon={<StopIcon size={18} />}
                  onClick={stop}
                  className="mb-0.5"
                />
              </Tip>
            ) : (
              <Tip
                content={
                  connected
                    ? "Send (Enter). Shift+Enter adds a new line"
                    : "Connecting to the chat…"
                }
              >
                <Button
                  type="submit"
                  variant="primary"
                  shape="square"
                  aria-label="Send message"
                  disabled={!input.trim() || !connected}
                  icon={<PaperPlaneRightIcon size={18} />}
                  className="mb-0.5"
                />
              </Tip>
            )}
          </div>
        </form>
      </div>
    </main>
  );
}

function MessageView({
  message,
  showDebug,
  isAnimating,
  addToolApprovalResponse
}: {
  message: UIMessage;
  showDebug: boolean;
  isAnimating: boolean;
  addToolApprovalResponse: (response: {
    id: string;
    approved: boolean;
  }) => void;
}) {
  const isUser = message.role === "user";
  return (
    <div className="space-y-2">
      {showDebug && (
        <pre className="text-[11px] text-kumo-subtle bg-kumo-control rounded-lg p-3 overflow-auto max-h-64">
          {JSON.stringify(message, null, 2)}
        </pre>
      )}
      {message.parts.map((part, i) => {
        const key = `${message.id}-${i}`;
        if (isToolUIPart(part)) {
          return (
            <ToolPartView
              key={key}
              part={part}
              addToolApprovalResponse={addToolApprovalResponse}
            />
          );
        }
        if (part.type === "reasoning" && part.text.trim()) {
          return (
            <div key={key} className="flex justify-start">
              <details className="max-w-[85%] w-full">
                <summary
                  title="Show the model's reasoning"
                  className="flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg bg-purple-500/10 border border-purple-500/20 text-sm select-none"
                >
                  <BrainIcon size={14} className="text-purple-400" />
                  <span className="font-medium text-kumo-default">
                    Reasoning
                  </span>
                  <CaretDownIcon
                    size={14}
                    className="ml-auto text-kumo-inactive"
                  />
                </summary>
                <pre className="mt-2 px-3 py-2 rounded-lg bg-kumo-control text-xs text-kumo-default whitespace-pre-wrap overflow-auto max-h-64">
                  {part.text}
                </pre>
              </details>
            </div>
          );
        }
        if (part.type === "text" && part.text) {
          return isUser ? (
            <div key={key} className="flex justify-end">
              <div className="max-w-[85%] min-w-0 px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed whitespace-pre-wrap break-words">
                <UserText text={part.text} />
              </div>
            </div>
          ) : (
            <div key={key} className="flex justify-start">
              <div className="max-w-[85%] min-w-0 overflow-x-auto rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                <Streamdown
                  className="sd-theme rounded-2xl rounded-bl-md p-3"
                  plugins={{ code }}
                  controls={false}
                  // LLM output is untrusted: no raw HTML, no remote images
                  // (tracking beacons), and only https/mailto links.
                  skipHtml
                  disallowedElements={["img"]}
                  urlTransform={safeUrl}
                  isAnimating={isAnimating}
                >
                  {part.text}
                </Streamdown>
              </div>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

/** User text, with a leading slash command set in monospace. */
function UserText({ text }: { text: string }) {
  const command = parseSlashCommand(text);
  if (!command) return <>{text}</>;
  return (
    <>
      <span className="font-mono font-semibold">/{command.name}</span>
      {command.args && ` ${command.args}`}
    </>
  );
}
