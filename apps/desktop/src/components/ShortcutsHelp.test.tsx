// @vitest-environment jsdom
/** #318: shortcut-help overlay — groups live registry commands by section. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { afterEach, describe, expect, it } from "vitest";
import { ShortcutsHelp } from "./ShortcutsHelp";
import { installJsdomStubs } from "../quality/testEnv";
import { ja } from "../strings/ja";
import type { Command } from "../commands/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
installJsdomStubs();

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const noop = () => undefined;

function cmd(
  id: string,
  section: Command["section"],
  shortcuts?: readonly string[],
): Command {
  return { id, title: `${id}のタイトル`, section, shortcuts, run: noop };
}

async function mount(commands: readonly Command[], open = true) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <FluentProvider theme={webLightTheme}>
        <ShortcutsHelp commands={commands} open={open} onOpenChange={noop} />
      </FluentProvider>,
    );
  });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  // Fluent dialogs portal to document.body — clear leftovers.
  document.body.innerHTML = "";
});

describe("ShortcutsHelp (#318)", () => {
  it("renders bound commands grouped under their section headings", async () => {
    await mount([
      cmd("file.openAudio", "file", ["Ctrl+O"]),
      cmd("transport.playPause", "transport", ["Space", "K"]),
      cmd("app.help", "app", ["F1"]),
    ]);
    const kbdTexts = [...document.querySelectorAll(".hs-shortcuts__kbd")].map(
      (k) => k.textContent,
    );
    expect(kbdTexts).toContain("Ctrl+O");
    expect(kbdTexts).toContain("Space");
    expect(kbdTexts).toContain("F1");
    const sections = [...document.querySelectorAll(".hs-shortcuts__section")].map(
      (s) => s.textContent,
    );
    expect(sections).toEqual([
      ja.shortcutsHelp.sections.file,
      ja.shortcutsHelp.sections.transport,
      ja.shortcutsHelp.sections.app,
    ]);
  });

  it("omits commands that have no keyboard binding", async () => {
    await mount([cmd("file.openAudio", "file", ["Ctrl+O"]), cmd("x.y", "app")]);
    const names = [...document.querySelectorAll(".hs-shortcuts__name")].map(
      (n) => n.textContent,
    );
    expect(names).toHaveLength(1);
    expect(names[0]).toBe("file.openAudioのタイトル");
  });

  it("shows the empty state when nothing on screen is bound", async () => {
    await mount([cmd("x.y", "app")]);
    expect(document.querySelector(".hs-shortcuts__empty")?.textContent).toBe(
      ja.shortcutsHelp.empty,
    );
  });
});

