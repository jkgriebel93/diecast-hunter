import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import { ThemeProvider } from "./lib/theme";
import { FontScaleProvider } from "./lib/fontScale";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <FontScaleProvider>
        <HashRouter>
          <App />
        </HashRouter>
      </FontScaleProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
