import { useCallback, useMemo, useState } from "react";
import { Badge } from "@cloudflare/kumo";
import type { CommandInfo } from "../plugins/registry";
import { parseSlashCommand } from "../shared";

/** While the input is just "/partial-name", the commands that match it. */
const matchCommands = (input: string, commands: CommandInfo[]) => {
  const partial = /^\/([a-z0-9-]*)$/.exec(input)?.[1];
  return partial === undefined
    ? []
    : commands.filter((c) => c.name.startsWith(partial));
};

/** The known command at the start of the input, if any (for the hint line). */
export const activeCommand = (input: string, commands: CommandInfo[]) => {
  const parsed = parseSlashCommand(input);
  return parsed ? commands.find((c) => c.name === parsed.name) : undefined;
};

export const commandText = (command: CommandInfo) => `/${command.name} `;

/**
 * Slash-command autocomplete state for a text input. `onKeyDown` returns true
 * when it handled the key, so the caller should skip its own handling.
 */
export function useCommandMenu(
  input: string,
  commands: CommandInfo[],
  onComplete: (command: CommandInfo, submit: boolean) => void
) {
  const matches = useMemo(
    () => matchCommands(input, commands),
    [input, commands]
  );
  // The highlight belongs to the input it was set for, so it resets to the
  // first match whenever the input changes (derived during render).
  const [selection, setSelection] = useState({ input, index: 0 });
  const highlight = selection.input === input ? selection.index : 0;
  const setHighlight = useCallback(
    (index: number) => setSelection({ input, index }),
    [input]
  );
  const [dismissedFor, setDismissedFor] = useState<string>();

  const open = matches.length > 0 && dismissedFor !== input;

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!open) return false;
      const selected = matches[highlight];
      switch (e.key) {
        case "ArrowDown":
          setHighlight((highlight + 1) % matches.length);
          break;
        case "ArrowUp":
          setHighlight((highlight - 1 + matches.length) % matches.length);
          break;
        case "Tab":
          onComplete(selected, false);
          break;
        case "Enter":
          if (e.shiftKey) return false;
          // Commands that take no arguments run immediately.
          onComplete(selected, !selected.argumentHint);
          break;
        case "Escape":
          setDismissedFor(input);
          break;
        default:
          return false;
      }
      e.preventDefault();
      return true;
    },
    [open, matches, highlight, setHighlight, input, onComplete]
  );

  return { open, matches, highlight, setHighlight, onKeyDown };
}

export function CommandMenu({
  menu,
  onSelect
}: {
  menu: ReturnType<typeof useCommandMenu>;
  onSelect: (command: CommandInfo) => void;
}) {
  if (!menu.open) return null;
  return (
    <ul
      aria-label="Commands"
      className="absolute bottom-full left-0 right-0 mb-2 max-h-64 overflow-y-auto rounded-xl border border-kumo-line bg-kumo-base shadow-lg p-1 z-20"
    >
      {menu.matches.map((c, i) => (
        <li key={c.name}>
          <button
            type="button"
            aria-current={i === menu.highlight}
            onMouseEnter={() => menu.setHighlight(i)}
            onMouseDown={(e) => {
              e.preventDefault(); // keep focus in the input
              onSelect(c);
            }}
            className={`w-full flex items-baseline gap-2 px-3 py-2 rounded-lg text-left text-sm ${i === menu.highlight ? "bg-kumo-control" : ""}`}
          >
            <span className="font-mono text-kumo-default">/{c.name}</span>
            {c.kind === "workflow" && (
              <Badge variant="secondary">workflow</Badge>
            )}
            {c.argumentHint && (
              <span className="font-mono text-xs text-kumo-subtle">
                {c.argumentHint}
              </span>
            )}
            <span className="ml-auto text-xs text-kumo-subtle truncate">
              {c.description}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
