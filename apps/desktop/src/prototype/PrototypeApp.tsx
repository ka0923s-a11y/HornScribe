import { useEffect, useState } from "react";
import { FluentProvider } from "@fluentui/react-components";
import { ja } from "../strings/ja";
import { hsLightTheme, hsDarkTheme, type ThemeMode } from "../theme/fluentTheme";
import { useThemeMode } from "../theme/useThemeMode";
import { IndexPage } from "./pages/IndexPage";
import { ShellPage } from "./pages/ShellPage";
import { DensityPage } from "./pages/DensityPage";
import { ScorePage } from "./pages/ScorePage";
import { ReviewPage } from "./pages/ReviewPage";
import { ExportPage } from "./pages/ExportPage";
import "./prototype.css";

/**
 * UI-009 preproduction prototype pack (issue #31).
 * Mounted only under hash routes `#/prototype/*` (lazy chunk from main.tsx).
 * All state is deterministic mock data — no engine, no audio, no persistence.
 */

type Route = "index" | "shell" | "density" | "score" | "review" | "export";

const ROUTES: Route[] = ["shell", "density", "score", "review", "export"];

/** `#/prototype/<route>/<param...>` → deep-linkable mock states. */
function parseHash(): { route: Route; params: string[] } {
  const h = window.location.hash.replace(/^#\/?prototype\/?/, "");
  const [head, ...rest] = h.split("/").filter(Boolean);
  const route = (ROUTES as string[]).includes(head) ? (head as Route) : "index";
  return { route, params: rest };
}

function useHashRoute(): { route: Route; params: string[] } {
  const [state, setState] = useState(parseHash);
  useEffect(() => {
    const onHash = () => setState(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return state;
}

const PAGE_META: Record<Route, { hash: string; title: string }> = {
  index: { hash: "#/prototype", title: ja.prototype.nav.index },
  shell: { hash: "#/prototype/shell", title: ja.prototype.pages.shell.title },
  density: { hash: "#/prototype/density", title: ja.prototype.pages.density.title },
  score: { hash: "#/prototype/score", title: ja.prototype.pages.score.title },
  review: { hash: "#/prototype/review", title: ja.prototype.pages.review.title },
  export: { hash: "#/prototype/export", title: ja.prototype.pages.export.title },
};

export default function PrototypeApp() {
  const { mode, resolved, select } = useThemeMode();
  const { route, params } = useHashRoute();
  const theme = resolved === "dark" ? hsDarkTheme : hsLightTheme;
  const nav = ja.prototype.nav;

  const exitPrototype = () => {
    window.location.hash = "";
    window.location.reload();
  };

  return (
    <FluentProvider theme={theme}>
      <div className="hs-proto-page">
        <nav className="hs-proto-nav" aria-label={nav.regionLabel}>
          <span className="hs-proto-nav__badge">{nav.badge}</span>
          {(Object.keys(PAGE_META) as Route[]).map((key) => (
            <a
              key={key}
              href={PAGE_META[key].hash}
              aria-current={route === key ? "page" : undefined}
            >
              {PAGE_META[key].title}
            </a>
          ))}
          <span className="hs-proto-nav__spacer" />
          <label>
            {nav.themeLabel}:{" "}
            <select
              value={mode}
              onChange={(e) => select(e.target.value as ThemeMode)}
              aria-label={nav.themeLabel}
            >
              <option value="system">{nav.themeSystem}</option>
              <option value="light">{nav.themeLight}</option>
              <option value="dark">{nav.themeDark}</option>
            </select>
          </label>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              exitPrototype();
            }}
          >
            {nav.exit}
          </a>
        </nav>

        {route === "index" && <IndexPage />}
        {route === "shell" && <ShellPage key={params.join("/")} initial={params[0]} />}
        {route === "density" && (
          <DensityPage key={params.join("/")} view={params[0]} theme={params[1]} />
        )}
        {route === "score" && <ScorePage />}
        {route === "review" && <ReviewPage />}
        {route === "export" && (
          <ExportPage key={params.join("/")} initial={params[0]} phase={params[1]} />
        )}
      </div>
    </FluentProvider>
  );
}
