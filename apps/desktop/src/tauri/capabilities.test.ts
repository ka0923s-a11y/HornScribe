/**
 * @vitest-environment node
 *
 * #407 regression guard: onCloseRequested's non-prevented path calls
 * plugin:window|destroy internally, and every confirmed-exit button
 * goes through requestAppExit → destroy(). Without
 * core:window:allow-destroy the packaged app cannot be closed at all —
 * keep the grant pinned here.
 */
import { describe, expect, it } from "vitest";
import capabilities from "../../src-tauri/capabilities/default.json";

describe("window capabilities (#407)", () => {
  const perms: readonly string[] = capabilities.permissions;

  it("grants core:window:allow-destroy for close/exit paths", () => {
    expect(perms).toContain("core:window:allow-destroy");
  });

  it("still scopes the grant to the main window only", () => {
    expect(capabilities.windows).toEqual(["main"]);
  });
});
