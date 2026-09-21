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
  return capped;
}

/** Drop a path (e.g. user removes a dead entry later on). */
export function removeRecentProject(
  path: string,
  storage: Pick<Storage, "getItem" | "setItem"> | null = defaultStorage(),
): RecentProjectEntry[] {
  const list = loadRecentProjects(storage).filter((e) => e.path !== path);
  persist(list, storage);
  return list;
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
