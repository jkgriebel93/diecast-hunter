import { Navigate, Route, Routes } from "react-router-dom";
import { ActivityBar } from "@/components/ActivityBar";
import { Sidebar } from "@/components/Sidebar";
import { Dashboard } from "@/pages/Dashboard";
import { Collection } from "@/pages/Collection";
import { Listings } from "@/pages/Listings";
import { Browse } from "@/pages/Browse";
import { Ebay } from "@/pages/Ebay";
import { SavedSearches } from "@/pages/SavedSearches";
import { SellerFeed } from "@/pages/SellerFeed";
import { Registry } from "@/pages/Registry";
import { Settings } from "@/pages/Settings";

export default function App() {
  return (
    <div className="flex h-full">
      <ActivityBar />
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/collection" element={<Collection />} />
          <Route path="/ebay" element={<Ebay />} />
          <Route path="/ebay/feed" element={<SellerFeed />} />
          <Route path="/ebay/searches" element={<SavedSearches />} />
          <Route
            path="/ebay/sellers"
            element={<Navigate to="/ebay/feed" replace />}
          />
          <Route path="/listings" element={<Listings />} />
          <Route path="/browse" element={<Browse />} />
          <Route path="/registry" element={<Registry />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
