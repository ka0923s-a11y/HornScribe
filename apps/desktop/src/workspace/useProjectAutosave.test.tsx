// @vitest-environment jsdom
// #408: autosave failure must not be silent — a rejecting recovery
// write flips the health flag (statusbar warning), a landed write
// clears it, and any clean state (manual save / undo-to-baseline)
// clears it too. Raw errors go to the log, never the surface.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installJsdomStubs } from "../quality/testEnv";
import { useProjectAutosave } from "./useProjectAutosave";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
installJsdomStubs();

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function Harness(props: {
  readonly dirty: boolean;
  readonly version: number | null;
  readonly write: (contents: string) => Promise<void>;
  readonly snapshot?: () => Promise<string | null>;
}) {
  const failed = useProjectAutosave({
    enabled: true,
    dirty: props.dirty,
    version: props.version,
    snapshot: props.snapshot ?? (async () => "{}"),
    write: props.write,
    intervalMs: 5,
  });
  return <div data-testid="failed">{String(failed)}</div>;
}

async function mount(props: Parameters<typeof Harness>[0]): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Harness {...props} />);
  });
}

async function rerender(props: Parameters<typeof Harness>[0]): Promise<void> {
  await act(async () => {
    root!.render(<Harness {...props} />);
  });
}

async function tick(ms = 60): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

const flag = () => host!.querySelector("[data-testid=failed]")!.textContent;

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

describe("useProjectAutosave (#408)", () => {
  it("a rejecting write flips the health flag instead of staying silent", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const write = vi.fn(() =>
      Promise.reject(new Error("DISK_FULL: no space left on device")),
    );
    await mount({ dirty: true, version: 1, write });
    await tick();
    expect(flag()).toBe("true");
    expect(write).toHaveBeenCalled();
    // The raw error is logged for diagnostics — never rendered.
    expect(log).toHaveBeenCalled();
  });

  it("a landed write after a failure clears the warning", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const write = vi.fn(() =>
      fail
        ? Promise.reject(new Error("invoke failed"))
        : Promise.resolve(),
    );
    await mount({ dirty: true, version: 1, write });
    await tick();
    expect(flag()).toBe("true");

    fail = false;
    await rerender({ dirty: true, version: 2, write });
    await tick();
    expect(flag()).toBe("false");
  });

  it("going clean (manual save / undo) clears a stale warning", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const write = vi.fn(() => Promise.reject(new Error("io error")));
    await mount({ dirty: true, version: 1, write });
    await tick();
    expect(flag()).toBe("true");

    await rerender({ dirty: false, version: 1, write });
    expect(flag()).toBe("false");
  });

  it("a null snapshot writes nothing and never fails", async () => {
    const write = vi.fn(() => Promise.resolve());
    await mount({
      dirty: true,
      version: 1,
      write,
      snapshot: async () => null,
    });
    await tick();
    expect(write).not.toHaveBeenCalled();
    expect(flag()).toBe("false");
  });

  it("no new edits means no repeated writes", async () => {
    const write = vi.fn(() => Promise.resolve());
    await mount({ dirty: true, version: 1, write });
    await tick(80);
    expect(write).toHaveBeenCalledTimes(1);
    expect(flag()).toBe("false");
  });
});