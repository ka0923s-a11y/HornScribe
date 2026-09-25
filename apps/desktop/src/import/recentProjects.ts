/**
 * 最近使ったプロジェクト (GUI_UX_SPEC §3: shown only when history exists).
 *
 * localStorage-backed MRU of `.hornscribe.json` files. Entries are recorded
 * on successful project opens; a failed open keeps the entry (the error UX
 * — e.g. SOURCE_MISSING relink — is where the user decides what to do).
 * Best-effort: storage failures degrade to an in-memory list.
 */
import type { RecentProjectEntry } from "./types";

const STORAGE_KEY = "hornscribe.recentProjects.v1";
export const MAX_RECENT_PROJECTS = 8;

/** Paths whose last auto-open attempt failed with projectOpenFailed —
 *  skipped at launch so a dead MRU head cannot error-loop every start
 *  (#364). Manual opens still work; a successful record clears it. */
const SKIP_KEY = "hornscribe.recentProjects.autoOpenSkip.v1";

function isEntry(v: unknown): v is RecentProjectEntry {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as RecentProjectEntry).name === "string" &&
    typeof (v as RecentProjectEntry).path === "string" &&
    typeof (v as RecentProjectEntry).openedAt === "number"
  );
}

export function loadRecentProjects(
  storage: Pick<Storage, "getItem"> | null = defaultStorage(),
): RecentProjectEntry[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isEntry)
      .sort((a, b) => b.openedAt - a.openedAt)
      .slice(0, MAX_RECENT_PROJECTS);
  } catch {
    return [];
  }
}

/**
 * Insert/touch `path` as the most-recent entry, deduped by path, capped at
 * MAX_RECENT_PROJECTS. Returns the updated list (also persisted).
 */
export function recordRecentProject(
  entry: { name: string; path: string },
  storage: Pick<Storage, "getItem" | "setItem"> | null = defaultStorage(),
  now = Date.now(),
): RecentProjectEntry[] {
  const list = loadRecentProjects(storage).filter((e) => e.path !== entry.path);
  list.unshift({ ...entry, openedAt: now });
  const capped = list.slice(0, MAX_RECENT_PROJECTS);
  persist(capped, storage);
  clearAutoOpenSkip(entry.path, storage);
  return capped;
}

/** Drop a path — the 履歴から削除 affordance on the empty-state list and
 *  the projectOpenFailed card (#364). */
export function removeRecentProject(
  path: string,
  storage: Pick<Storage, "getItem" | "setItem"> | null = defaultStorage(),
): RecentProjectEntry[] {
  const list = loadRecentProjects(storage).filter((e) => e.path !== path);
  persist(list, storage);
  clearAutoOpenSkip(path, storage);
  return list;
}

export function loadAutoOpenSkips(
  storage: Pick<Storage, "getItem"> | null = defaultStorage(),
): string[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(SKIP_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((p): p is string => typeof p === "string")
      : [];
  } catch {
    return [];
  }
}

/** Mark a path as failing to open — skipped by the launch auto-open until
 *  a manual open of the same path succeeds (recordRecentProject clears
 *  it). A set, not a single value: consecutive dead entries must not
 *  ping-pong the marker between each other. */
export function markAutoOpenFailed(
  path: string,
  storage: Pick<Storage, "getItem" | "setItem"> | null = defaultStorage(),
): void {
  if (!path || !storage) return;
  const next = [path, ...loadAutoOpenSkips(storage).filter((p) => p !== path)];
  try {
    storage.setItem(SKIP_KEY, JSON.stringify(next.slice(0, MAX_RECENT_PROJECTS)));
  } catch {
    /* best-effort */
  }
}

export function clearAutoOpenSkip(
  path: string,
  storage: Pick<Storage, "getItem" | "setItem"> | null = defaultStorage(),
): void {
  if (!storage) return;
  const next = loadAutoOpenSkips(storage).filter((p) => p !== path);
  try {
    storage.setItem(SKIP_KEY, JSON.stringify(next));
  } catch {
    /* best-effort */
  }
}

/** The MRU entry the launch auto-open should attempt: the first path not
 *  on the failed-open skip set; undefined when every recent is known-dead
 *  (stay on EMPTY). */
export function nextAutoOpenEntry(
  list: readonly RecentProjectEntry[],
  storage: Pick<Storage, "getItem"> | null = defaultStorage(),
): RecentProjectEntry | undefined {
  const skips = new Set(loadAutoOpenSkips(storage));
  return list.find((e) => !skips.has(e.path));
}

function persist(
  list: RecentProjectEntry[],
  storage: Pick<Storage, "setItem"> | null,
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* persistence is best-effort */
  }
}

function defaultStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}
