import type { ReactNode } from "react";
import { useWorkspace } from "@/lib/workspace";
import type { ViewId } from "@/lib/views";

/**
 * In-app navigation that targets the split-view workspace instead of the
 * router. Drop-in replacement for the old react-router `<Link to=…>` used for
 * cross-page links: clicking opens the target view in the focused pane (or in a
 * new pane to the side when `side` is set). Renders an anchor so it keeps the
 * same inline/grid layout behavior the `<Link>` had.
 */
export function ViewLink({
  to,
  className,
  children,
  side = false,
  title,
}: {
  to: ViewId;
  className?: string;
  children: ReactNode;
  side?: boolean;
  title?: string;
}) {
  const { open, openInNewPane } = useWorkspace();
  const go = () => (side ? openInNewPane(to) : open(to));

  return (
    <a
      role="button"
      tabIndex={0}
      title={title}
      className={`cursor-pointer ${className ?? ""}`}
      onClick={go}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      }}
    >
      {children}
    </a>
  );
}
