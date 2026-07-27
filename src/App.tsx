import { ActivityBar } from "@/components/ActivityBar";
import { Sidebar } from "@/components/Sidebar";
import { TrainingBanner } from "@/components/TrainingBanner";
import { Workspace } from "@/components/Workspace";
import { WorkspaceProvider } from "@/lib/workspace";

export default function App() {
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
