import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, type UIMessage } from "ai";
import { Button, Empty, InputArea } from "@cloudflare/kumo";
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
import { chatAgentName } from "../shared";
import { ToolPartView } from "./tool-part";

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

const SUGGESTED_PROMPTS = [
  "What's our biggest schedule risk right now?",
  "Which suppliers are on the critical path, and how much slack do we have?",
  "Draft a weekly status report for leadership",
  "Remind me in 1 minute to review the RAID log"
];

export function Chat({
  projectId,
  chatId,
  showDebug,
  onConnectionChange
}: {
  projectId: string;
  chatId: string;
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
    useAgentChat({
      agent,
      experimental_throttle: 100
    });

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

  return (
    <main className="flex-1 flex flex-col min-w-0">
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {messages.length === 0 && (
            <Empty
              icon={<TruckIcon size={32} />}
              title="Your program copilot"
              description="Ask about schedule risk, paste meeting notes to update the RAID log, or draft a status report. Changes appear live on the dashboard."
              contents={
                <div className="flex flex-col items-stretch gap-2 max-w-xl">
                  {SUGGESTED_PROMPTS.map((prompt) => (
                    <Button
                      key={prompt}
                      variant="outline"
                      size="sm"
                      className="h-auto! py-2 text-left whitespace-normal justify-start"
                      disabled={isStreaming || !connected}
                      onClick={() => sendText(prompt)}
                    >
                      {prompt}
                    </Button>
                  ))}
                </div>
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
          className="max-w-3xl mx-auto px-5 py-4"
        >
          <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
            {voice.supported && (
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
            )}
            <InputArea
              ref={textareaRef}
              value={input}
              onValueChange={setInput}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${el.scrollHeight}px`;
              }}
              placeholder={
                voice.listening
                  ? "Listening…"
                  : "Ask about the project, or paste meeting notes…"
              }
              disabled={!connected || isStreaming}
              rows={1}
              className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none! resize-none max-h-40"
            />
            {isStreaming ? (
              <Button
                type="button"
                variant="secondary"
                shape="square"
                aria-label="Stop generation"
                icon={<StopIcon size={18} />}
                onClick={stop}
                className="mb-0.5"
              />
            ) : (
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send message"
                disabled={!input.trim() || !connected}
                icon={<PaperPlaneRightIcon size={18} />}
                className="mb-0.5"
              />
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
                <summary className="flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg bg-purple-500/10 border border-purple-500/20 text-sm select-none">
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
              <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed whitespace-pre-wrap">
                {part.text}
              </div>
            </div>
          ) : (
            <div key={key} className="flex justify-start">
              <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                <Streamdown
                  className="sd-theme rounded-2xl rounded-bl-md p-3"
                  plugins={{ code }}
                  controls={false}
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
