import { useEffect } from "react";
import { ActivityBar } from "@/components/ActivityBar";
import { Sidebar } from "@/components/Sidebar";
import { TrainingBanner } from "@/components/TrainingBanner";
import { Workspace } from "@/components/Workspace";
import { WorkspaceProvider } from "@/lib/workspace";
import { api } from "@/lib/tauri";

export default function App() {
  // One-shot ready signal (DCH-60). This effect runs after the whole tree's
  // mount effects — i.e. after every restored tab has issued its first
  // fetches — so the backend's startup backfill queues behind them on the
  // connection pool instead of racing the first paint. Best-effort: the
  // backend has its own timeout fallback.
  useEffect(() => {
    api.frontendReady().catch(() => {});
  }, []);

  return (
    <WorkspaceProvider>
      <div className="flex flex-col h-full">
        <TrainingBanner />
        <div className="flex flex-1 min-h-0">
          <ActivityBar />
          <Sidebar />
          <Workspace />
        </div>
      </div>
    </WorkspaceProvider>
  );
}
