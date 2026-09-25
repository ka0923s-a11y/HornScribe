/**
 * Recent-projects MRU tests (UI-020 / GUI_UX_SPEC §3). Storage is injected
 * so the list logic runs without a DOM; failures degrade to empty/in-memory.
 */

import { describe, expect, it } from "vitest";
import {
  loadAutoOpenSkips,
  markAutoOpenFailed,
  MAX_RECENT_PROJECTS,
  loadRecentProjects,
  nextAutoOpenEntry,
  recordRecentProject,
  removeRecentProject,
} from "./recentProjects";

/** Map-backed Storage stub (getItem/setItem only — all the module uses). */
function memStorage(seed?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  };
}

const KEY = "hornscribe.recentProjects.v1";

describe("loadRecentProjects", () => {
  it("returns [] with no storage", () => {
    expect(loadRecentProjects(null)).toEqual([]);
  });

  it("returns [] on corrupt JSON instead of throwing", () => {
    const s = memStorage({ [KEY]: "{not json" });
    expect(loadRecentProjects(s)).toEqual([]);
  });

  it("drops malformed entries and sorts newest-first", () => {
    const s = memStorage({
      [KEY]: JSON.stringify([
        { name: "old", path: "/p/old", openedAt: 1 },
        { bogus: true },
        { name: "new", path: "/p/new", openedAt: 9 },
        { name: "mid", path: "/p/mid", openedAt: 5 },
      ]),
    });
    expect(loadRecentProjects(s).map((e) => e.name)).toEqual([
      "new",
      "mid",
      "old",
    ]);
  });
});

describe("recordRecentProject", () => {
  it("unshifts the entry and persists it", () => {
    const s = memStorage();
    const list = recordRecentProject({ name: "a", path: "/p/a" }, s, 100);
    expect(list[0]).toEqual({ name: "a", path: "/p/a", openedAt: 100 });
    expect(loadRecentProjects(s)[0]?.path).toBe("/p/a");
  });

  it("dedupes by path and bumps openedAt", () => {
    const s = memStorage();
    recordRecentProject({ name: "a", path: "/p/a" }, s, 100);
    recordRecentProject({ name: "b", path: "/p/b" }, s, 200);
    const list = recordRecentProject({ name: "a2", path: "/p/a" }, s, 300);
    expect(list.map((e) => e.path)).toEqual(["/p/a", "/p/b"]);
    expect(list[0]).toMatchObject({ name: "a2", openedAt: 300 });
  });

  it("caps the list at MAX_RECENT_PROJECTS", () => {
    const s = memStorage();
    for (let i = 0; i < MAX_RECENT_PROJECTS + 3; i++) {
      recordRecentProject({ name: `p${i}`, path: `/p/${i}` }, s, i);
    }
    const list = loadRecentProjects(s);
    expect(list).toHaveLength(MAX_RECENT_PROJECTS);
    expect(list[0]?.path).toBe(`/p/${MAX_RECENT_PROJECTS + 2}`);
  });
});

describe("removeRecentProject", () => {
  it("removes by path and persists", () => {
    const s = memStorage();
    recordRecentProject({ name: "a", path: "/p/a" }, s, 1);
    recordRecentProject({ name: "b", path: "/p/b" }, s, 2);
    const list = removeRecentProject("/p/a", s);
    expect(list.map((e) => e.path)).toEqual(["/p/b"]);
    expect(loadRecentProjects(s).map((e) => e.path)).toEqual(["/p/b"]);
  });
});

describe("auto-open skip set (#364)", () => {
  it("nextAutoOpenEntry returns the MRU head when nothing is marked", () => {
    const s = memStorage();
    const list = recordRecentProject({ name: "a", path: "/p/a" }, s, 1);
    expect(nextAutoOpenEntry(list, s)?.path).toBe("/p/a");
  });

  it("skips marked heads and falls through to the next live entry", () => {
    const s = memStorage();
    recordRecentProject({ name: "a", path: "/p/a" }, s, 1);
    const list = recordRecentProject({ name: "b", path: "/p/b" }, s, 2);
    markAutoOpenFailed("/p/b", s);
    expect(nextAutoOpenEntry(list, s)?.path).toBe("/p/a");
  });

  it("returns undefined when every entry is marked — stay on EMPTY", () => {
    const s = memStorage();
    const list = recordRecentProject({ name: "a", path: "/p/a" }, s, 1);
    markAutoOpenFailed("/p/a", s);
    expect(nextAutoOpenEntry(list, s)).toBeUndefined();
  });

  it("two dead entries do not ping-pong the marker", () => {
    const s = memStorage();
    recordRecentProject({ name: "a", path: "/p/a" }, s, 1);
    const list = recordRecentProject({ name: "b", path: "/p/b" }, s, 2);
    markAutoOpenFailed("/p/b", s);
    markAutoOpenFailed("/p/a", s);
    expect(nextAutoOpenEntry(list, s)).toBeUndefined();
    expect(loadAutoOpenSkips(s).sort()).toEqual(["/p/a", "/p/b"]);
  });

  it("a successful open clears the mark (file repaired/relocated)", () => {
    const s = memStorage();
    recordRecentProject({ name: "a", path: "/p/a" }, s, 1);
    markAutoOpenFailed("/p/a", s);
    const list = recordRecentProject({ name: "a", path: "/p/a" }, s, 2);
    expect(loadAutoOpenSkips(s)).toEqual([]);
    expect(nextAutoOpenEntry(list, s)?.path).toBe("/p/a");
  });

  it("removing an entry also drops its mark", () => {
    const s = memStorage();
    recordRecentProject({ name: "a", path: "/p/a" }, s, 1);
    markAutoOpenFailed("/p/a", s);
    removeRecentProject("/p/a", s);
    expect(loadAutoOpenSkips(s)).toEqual([]);
  });
});
