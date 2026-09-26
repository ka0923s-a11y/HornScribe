// @vitest-environment jsdom
/**
 * #384 export error surfaces — each stable ExportErrorCode must land on
 * a recovery surface whose actions match the actual cause (GUI_UX_SPEC
 * §20): no fixed "別の保存先を選ぶ" on failures the destination can't
 * fix, no raw engine detail in the body, and the transactional kept
 * state stated explicitly.
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportDialog } from "./ExportDialog";
import { MockExportPort } from "./mockPort";
import type { ExportErrorCode, ExportFormatId } from "./types";
import { installJsdomStubs } from "../quality/testEnv";
import { ja } from "../strings/ja";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
installJsdomStubs();

const NOOP = () => undefined;

const ALL_SELECTED: Record<ExportFormatId, boolean> = {
  concertMusicxml: true,
  hornMusicxml: true,
  concertPdf: false,
  hornPdf: false,
  playbackMidi: true,
  sourceAudio: false,
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(code: ExportErrorCode): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ExportDialog
        open={true}
        onOpenChange={NOOP}
        port={new MockExportPort({ failure: code, latencyMs: 0 })}
        defaultDestination="C:\\out"
        onOpenSettings={NOOP}
        onOpenDiagnostics={NOOP}
        onAnnounce={NOOP}
        initialSelected={ALL_SELECTED}
        suggestedBasename="take1"
      />,
    );
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
}

function buttonTexts(): string[] {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].map(
    (b) => b.textContent?.trim() ?? "",
  );
}

async function submitAndFail(): Promise<void> {
  // loading → form
  await flush();
  const submit = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => b.textContent?.trim() === ja.exportSheet.submit);
  expect(submit, "submit button on the export form").toBeTruthy();
  await act(async () => {
    submit!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  // running → error
  await flush();
  await flush();
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
});

describe("export error surfaces (#384)", () => {
  it.each<{ code: ExportErrorCode; title: string; present: string[]; absent: string[] }>([
    {
      code: "EXPORT_MUSESCORE_RENDER_FAILED",
      title: ja.errors.exportRenderFailed.title,
      present: ["再試行", "診断情報", "閉じる"],
      absent: ["別の保存先を選ぶ", "MuseScoreの場所を指定"],
    },
    {
      code: "EXPORT_DISK_FULL",
      title: ja.errors.exportDiskFull.title,
      present: ["別の保存先を選ぶ", "再試行", "閉じる"],
      absent: ["診断情報", "MuseScoreの場所を指定"],
    },
    {
      code: "EXPORT_SOURCE_MISSING",
      title: ja.errors.exportSourceMissing.title,
      present: ["書き出し設定に戻る", "閉じる"],
      absent: ["別の保存先を選ぶ", "再試行"],
    },
    {
      code: "EXPORT_DESTINATION_INVALID",
      title: ja.errors.exportDestinationInvalid.title,
      present: ["別の保存先を選ぶ", "閉じる"],
      absent: ["再試行"],
    },
    {
      code: "EXPORT_COMMIT_FAILED",
      title: ja.errors.exportCommitFailed.title,
      present: ["再試行", "別の保存先を選ぶ", "閉じる"],
      absent: ["診断情報"],
    },
    {
      code: "EXPORT_NAME_EXHAUSTED",
      title: ja.errors.exportNameExhausted.title,
      present: ["書き出し設定に戻る", "閉じる"],
      absent: ["別の保存先を選ぶ"],
    },
    {
      code: "EXPORT_INTERNAL",
      title: ja.errors.exportInternal.title,
      present: ["再試行", "診断情報", "閉じる"],
      absent: ["別の保存先を選ぶ"],
    },
    {
      code: "EXPORT_FAILED",
      title: ja.errors.exportFailed.title,
      present: ["再試行", "診断情報", "閉じる"],
      absent: ["別の保存先を選ぶ"],
    },
    {
      code: "MUSESCORE_UNAVAILABLE",
      title: ja.errors.musescoreMissing.title,
      present: ["MuseScoreの場所を指定", "閉じる"],
      absent: ["別の保存先を選ぶ"],
    },
    {
      code: "PERMISSION_DENIED",
      title: ja.errors.exportPermissionDenied.title,
      present: ["別の保存先を選ぶ", "閉じる"],
      absent: ["診断情報"],
    },
  ])("$code shows the $title recovery surface", async ({ code, title, present, absent }) => {
    await mount(code);
    await submitAndFail();
    const text = document.body.textContent ?? "";
    expect(text).toContain(title);
    const buttons = buttonTexts();
    for (const label of present) {
      expect(buttons, `expected action ${label}`).toContain(label);
    }
    for (const label of absent) {
      expect(buttons, `irrelevant action ${label} must not render`).not.toContain(label);
    }
    // Raw mock/engine detail never reaches the dialog body.
    expect(text).not.toContain("mock export failure");
  });

  it("states the untouched-destination guarantee on staging failures", async () => {
    await mount("EXPORT_MUSESCORE_RENDER_FAILED");
    await submitAndFail();
    expect(document.body.textContent).toContain(ja.errors.exportShared.kept);
    expect(document.body.textContent).not.toContain(
      ja.errors.exportShared.keptPartial,
    );
  });

  it("warns about a possible partial set on commit failure", async () => {
    await mount("EXPORT_COMMIT_FAILED");
    await submitAndFail();
    expect(document.body.textContent).toContain(
      ja.errors.exportShared.keptPartial,
    );
    expect(document.body.textContent).not.toContain(ja.errors.exportShared.kept);
  });

  it("makes no kept-state claim on unknown generic failures", async () => {
    await mount("EXPORT_FAILED");
    await submitAndFail();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain(ja.errors.exportShared.kept);
    expect(text).not.toContain(ja.errors.exportShared.keptPartial);
  });
});

describe("selection persistence (#377)", () => {
  it("survives an unstable onSelectionChange prop without render-looping", async () => {
    // Regression: the persist effect keyed on the callback prop, so an
    // inline parent closure that setStates on every call looped
    // update→render→update (Maximum update depth exceeded). The effect
    // now keys on the selection alone and reads the latest callback
    // through a ref.
    const calls: Array<Record<ExportFormatId, boolean>> = [];
    function Harness() {
      // Merge-style state mirrors useAppSettings: every update returns
      // a new object → parent re-render → fresh inline closure — the
      // exact prop-identity churn that caused the storm.
      const [settings, setSettings] = useState({
        exportFormats: ALL_SELECTED,
      });
      return (
        <ExportDialog
          open={true}
          onOpenChange={NOOP}
          port={new MockExportPort({ latencyMs: 0 })}
          defaultDestination="C:\\out"
          onOpenSettings={NOOP}
          onOpenDiagnostics={NOOP}
          onAnnounce={NOOP}
          initialSelected={settings.exportFormats}
          onSelectionChange={(sel) => {
            calls.push(sel);
            setSettings((prev) => ({ ...prev, exportFormats: sel }));
          }}
          suggestedBasename="take1"
        />
      );
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<Harness />);
    });
    await flush(); // loading → form
    // No mount echo: the seeded set is what settings already holds.
    expect(calls.length).toBe(0);
    // A real toggle persists exactly once — then settles, no storm.
    const checkbox = document.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(checkbox, "a format checkbox on the export form").toBeTruthy();
    await act(async () => {
      checkbox!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(calls.length).toBe(1);
    expect(calls[0].concertMusicxml).toBe(false);
  });
});
