import { ActivityBar } from "@/components/ActivityBar";
import { Sidebar } from "@/components/Sidebar";
import { Workspace } from "@/components/Workspace";
import { WorkspaceProvider } from "@/lib/workspace";

export default function App() {
  return (
    <WorkspaceProvider>
      <div className="flex h-full">
        <ActivityBar />
        <Sidebar />
        <Workspace />
      </div>
    </WorkspaceProvider>
  );
}
