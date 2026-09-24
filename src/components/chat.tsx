import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, type UIMessage } from "ai";
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
import type { ChatAgent } from "../agents/chat-agent";
import type { CommandInfo } from "../plugins/catalog";
import { chatAgentName, parseSlashCommand } from "../shared";
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
  onresult: (e: {
    results: ArrayLike<ArrayLike<{ transcript: string }>>;
  }) => void;
  onend: () => void;
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

function useVoiceInput(onTranscript: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const SpeechRecognition = getSpeechRecognition();

  const toggle = useCallback(() => {
    if (!SpeechRecognition) return;
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const rec = new SpeechRecognition();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.onresult = (e) =>
      onTranscript(
        Array.from(e.results)
          .map((r) => r[0].transcript)
          .join("")
      );
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    setListening(true);
    rec.start();
  }, [SpeechRecognition, listening, onTranscript]);

  return { supported: !!SpeechRecognition, listening, toggle };
}

// ── Chat ──────────────────────────────────────────────────────────────

export function Chat({
  projectId,
  chatId,
  commands,
  showDebug,
  onConnectionChange
}: {
  projectId: string;
  chatId: string;
  commands: CommandInfo[];
  showDebug: boolean;
  onConnectionChange: (connected: boolean) => void;
}) {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const agent = useAgent<ChatAgent>({
    agent: "ChatAgent",
    name: chatAgentName(projectId, chatId),
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), [])
  });

  useEffect(
    () => onConnectionChange(connected),
    [connected, onConnectionChange]
  );

  const { messages, sendMessage, addToolApprovalResponse, stop, status } =
    useAgentChat({ agent });

  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!isStreaming) textareaRef.current?.focus();
  }, [isStreaming]);

  const sendText = useCallback(
    (text: string) =>
      sendMessage({ role: "user", parts: [{ type: "text", text }] }),
    [sendMessage]
  );

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendText(text);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [input, isStreaming, sendText]);

  const voice = useVoiceInput(setInput);

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
