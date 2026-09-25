// @vitest-environment jsdom
/** #406: command palette — filter, keyboard roaming, invoke gating. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
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
  return { id, title: id + "のタイトル", section, shortcuts, run: noop };
}

async function mount(
  commands: readonly Command[],
  enabled: readonly string[] = [],
  invoked: string[] = [],
  onClose: () => void = noop,
) {
  const enabledSet = new Set(enabled);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <FluentProvider theme={webLightTheme}>
        <CommandPalette
          commands={commands}
          isEnabled={(id) => enabledSet.has(id)}
          invoke={(id) => {
            invoked.push(id);
            return true;
          }}
          onClose={onClose}
        />
      </FluentProvider>,
    );
  });
}

async function key(k: string) {
  await act(async () => {
    document
      .querySelector(".hs-palette__input")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: k, bubbles: true }),
      );
  });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
});

describe("CommandPalette (#406)", () => {
  it("lists visible commands grouped by section with shortcuts", async () => {
    await mount([
      cmd("file.openAudio", "file", ["Ctrl+O"]),
      cmd("transport.playPause", "transport", ["Space"]),
      cmd("app.help", "app", ["F1"]),
    ]);
    const names = [...document.querySelectorAll(".hs-palette__name")].map(
      (n) => n.textContent,
    );
    expect(names).toEqual([
      "file.openAudioのタイトル",
      "transport.playPauseのタイトル",
      "app.helpのタイトル",
    ]);
    const sections = [
      ...document.querySelectorAll(".hs-palette__section"),
    ].map((s) => s.textContent);
    expect(sections).toEqual([
      ja.shortcutsHelp.sections.file,
      ja.shortcutsHelp.sections.transport,
      ja.shortcutsHelp.sections.app,
    ]);
    const kbds = [...document.querySelectorAll(".hs-palette__kbd")].map(
      (k) => k.textContent,
    );
    expect(kbds).toEqual(["Ctrl+O", "Space", "F1"]);
  });

  it("substring-filters on title, id and description", async () => {
    await mount([
      cmd("file.openAudio", "file"),
      cmd("transport.playPause", "transport"),
      {
        ...cmd("edit.fix", "edit"),
        description: "確認点を修正する",
      },
    ]);
    await act(async () => {
      const input = document.querySelector(
        ".hs-palette__input",
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "修正");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const names = [...document.querySelectorAll(".hs-palette__name")].map(
      (n) => n.textContent,
    );
    expect(names).toEqual(["edit.fixのタイトル"]);
  });

  it("arrows roam, Enter invokes the active command and closes", async () => {
    const invoked: string[] = [];
    const onClose = vi.fn();
    const enabled = ["file.a", "file.b", "file.c"];
    await mount(
      [cmd("file.a", "file"), cmd("file.b", "file"), cmd("file.c", "file")],
      enabled,
      invoked,
      onClose,
    );
    await key("ArrowDown");
    await key("ArrowDown");
    await key("Enter");
    expect(invoked).toEqual(["file.c"]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("a disabled row is listed but non-invokable", async () => {
    const invoked: string[] = [];
    await mount(
      [cmd("file.a", "file"), cmd("app.b", "app")],
      ["file.a"],
      invoked,
    );
    await key("End"); // app.b — disabled
    await key("Enter");
    expect(invoked).toEqual([]);
    expect(
      document
        .querySelector('[id="hs-palette-opt-app.b"]')
        ?.getAttribute("aria-disabled"),
    ).toBe("true");
    await key("ArrowUp"); // file.a — enabled
    await key("Enter");
    expect(invoked).toEqual(["file.a"]);
  });

  it("Escape closes without invoking", async () => {
    const invoked: string[] = [];
    const onClose = vi.fn();
    await mount([cmd("file.a", "file")], ["file.a"], invoked, onClose);
    await key("Escape");
    expect(onClose).toHaveBeenCalledOnce();
    expect(invoked).toEqual([]);
  });

  it("shows the empty state on a no-match query", async () => {
    await mount([cmd("file.a", "file")]);
    await act(async () => {
      const input = document.querySelector(
        ".hs-palette__input",
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "zzz");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.querySelector(".hs-palette__empty")?.textContent).toBe(
      ja.commandPalette.empty,
    );
  });
});
