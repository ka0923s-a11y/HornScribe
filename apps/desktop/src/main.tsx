import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./theme/tokens.css";
import "./styles.css";

// UI-009 (issue #31): the preproduction prototype pack lives behind hash
// routes (#/prototype/*) as a lazy chunk — it never loads in the normal shell.
// #76: DEV-only — without the gate the lazy chunk still ships in
// production bundles (dead spike weight, same pattern as DevGallery).
const PrototypeApp = import.meta.env.DEV
  ? lazy(() => import("./prototype/PrototypeApp"))
  : null;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {window.location.hash.startsWith("#/prototype") ? (
      PrototypeApp ? (
        <Suspense fallback={null}>
          <PrototypeApp />
        </Suspense>
      ) : (
        <App />
      )
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
