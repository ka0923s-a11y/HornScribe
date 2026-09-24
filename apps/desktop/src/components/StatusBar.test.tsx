// @vitest-environment jsdom
/** #300: the unsaved badge renders only while the score is dirty. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { StatusBar } from "./StatusBar";
import { installJsdomStubs } from "../quality/testEnv";
import { ja } from "../strings/ja";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
installJsdomStubs();

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(unsaved: boolean): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<StatusBar message="m" unsaved={unsaved} />);
  });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("StatusBar unsaved badge (#300)", () => {
  it("shows the badge while dirty", async () => {
    await mount(true);
    const badge = host!.querySelector(".hs-statusbar__unsaved");
    expect(badge?.textContent).toBe(ja.project.unsavedBadge);
  });

  it("hides the badge when clean", async () => {
    await mount(false);
    expect(host!.querySelector(".hs-statusbar__unsaved")).toBeNull();
  });
});
