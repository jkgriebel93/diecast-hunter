import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ViewerApp } from "./ViewerApp";
import { PhotoWindow } from "./PhotoWindow";
import { photoUrlFromSearch, viewerViewFromSearch } from "./lib/viewer";
import { ThemeProvider } from "./lib/theme";
import { FontScaleProvider } from "./lib/fontScale";
import "./index.css";

// `?viewer=<ViewId>` marks a secondary viewer window (DCH-64): one view,
// no workspace shell. `?photo=<url>` marks the enlarged-photo window
// (DCH-75). Anything else — including an unknown view id or a non-image
// photo URL — renders the normal app.
const viewerView = viewerViewFromSearch(window.location.search);
const photoUrl = photoUrlFromSearch(window.location.search);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <FontScaleProvider>
        {photoUrl ? (
          <PhotoWindow url={photoUrl} />
        ) : viewerView ? (
          <ViewerApp view={viewerView} />
        ) : (
          <App />
        )}
      </FontScaleProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
