import { useState } from "react";
import { Button } from "@cloudflare/kumo";
import {
  CaretDownIcon,
  CaretUpIcon,
  InfoIcon,
  WarningIcon
} from "@phosphor-icons/react";
import { isPersistent } from "../browser/storage";
import { Tip } from "./tip";

const COLLAPSED_KEY = "demoBannerCollapsed";

/**
 * Explains that this is a demo: chats and project data stay in this browser
 * and nothing is stored on the server. Can be collapsed, not dismissed.
 */
export function DemoBanner() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return sessionStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const persistent = isPersistent();

  const toggle = () => {
    setCollapsed(!collapsed);
    try {
      sessionStorage.setItem(COLLAPSED_KEY, collapsed ? "0" : "1");
    } catch {
      // Preference just won't persist.
    }
  };

  return (
    <div
      role="note"
      aria-label="Demo mode"
      className={`flex items-start gap-2 px-4 py-2 text-sm border-b ${
        persistent
          ? "bg-sky-500/10 text-sky-900 dark:text-sky-200 border-sky-500/20"
          : "bg-amber-500/15 text-amber-900 dark:text-amber-200 border-amber-500/30"
      }`}
    >
      {persistent ? (
        <InfoIcon size={16} className="mt-0.5 shrink-0" />
      ) : (
        <WarningIcon size={16} className="mt-0.5 shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <strong>Demo mode.</strong>{" "}
        {persistent
          ? "Your chats and project changes are saved only in this browser, never on our servers."
          : "This browser is blocking storage, so your chats and changes will be lost when you close this tab."}
        {!collapsed && (
          <span className="block text-xs mt-0.5 opacity-90">
            Nothing you type or import is stored permanently: clearing this
            site's data, or using another browser or device, starts fresh.
            Messages are sent to the AI model to answer them and aren't kept.
          </span>
        )}
      </div>
      <Tip
        content={collapsed ? "Show more about demo mode" : "Show less"}
        side="left"
      >
        <Button
          variant="ghost"
          shape="square"
          size="xs"
          aria-label={collapsed ? "Expand demo notice" : "Collapse demo notice"}
          aria-expanded={!collapsed}
          icon={
            collapsed ? <CaretDownIcon size={12} /> : <CaretUpIcon size={12} />
          }
          onClick={toggle}
        />
      </Tip>
    </div>
  );
}
