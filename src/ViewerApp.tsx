import { useWorkspace, WorkspaceProvider } from "@/lib/workspace";
import { VIEWS, type ViewId } from "@/lib/views";

/**
 * The viewer-window shell (DCH-64): one view standing alone — no sidebar, no
 * tab strip, no panes. Mounted by main.tsx when the URL carries a valid
 * `?viewer=<ViewId>`, which is how the backend's `open_viewer_window`
 * addresses it.
 *
 * It still wraps an (ephemeral, non-persisting) WorkspaceProvider because
 * pages navigate through `<ViewLink>`, which needs the workspace context: a
 * link click swaps which view this window shows, keeping "one view at a
 * time" without dead links. Deliberately absent: the `frontendReady` signal
 * (the startup backfill keys off the main window's first paint, not ours)
 * and anything that reads or writes `workspace.v1`.
 */
export function ViewerApp({ view }: { view: ViewId }) {
  return (
    <WorkspaceProvider initial={view} persist={false}>
      <ViewerContent />
    </WorkspaceProvider>
  );
}

function ViewerContent() {
  const { activeView } = useWorkspace();
  const { Component } = VIEWS[activeView];
  // The same scrollport shape EditorPane gives a pane's content, so pages
  // with sticky headers and internal scrollers behave identically here.
  return (
    <div className="relative h-full min-h-0">
      <div className="absolute inset-0 overflow-auto">
        <Component />
      </div>
    </div>
  );
}
