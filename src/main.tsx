import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ViewerApp } from "./ViewerApp";
import { viewerViewFromSearch } from "./lib/viewer";
import { ThemeProvider } from "./lib/theme";
import { FontScaleProvider } from "./lib/fontScale";
import "./index.css";

// `?viewer=<ViewId>` marks a secondary viewer window (DCH-64): one view,
// no workspace shell. Anything else — including an unknown view id from a
// stale shortcut — renders the normal app.
const viewerView = viewerViewFromSearch(window.location.search);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <FontScaleProvider>
        {viewerView ? <ViewerApp view={viewerView} /> : <App />}
      </FontScaleProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
