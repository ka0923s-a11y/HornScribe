import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./theme/tokens.css";
import "./styles.css";

// UI-009 (issue #31): the preproduction prototype pack lives behind hash
// routes (#/prototype/*) as a lazy chunk — it never loads in the normal shell.
const PrototypeApp = lazy(() => import("./prototype/PrototypeApp"));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {window.location.hash.startsWith("#/prototype") ? (
      <Suspense fallback={null}>
        <PrototypeApp />
      </Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
