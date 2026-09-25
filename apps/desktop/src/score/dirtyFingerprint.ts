/**
 * #338: dirty tracking by CONTENT IDENTITY, not a monotonic edit counter.
 *
 * `scoreDocument.editVersion` only ever increases — undoing every edit
 * back to the saved state still reads dirty, so the user gets a bogus
 * 未保存 guard and the title keeps its `*`. This fingerprint instead
 *  compares what the project file would actually persist: the canonical
 *  score revision, the overlay note edits, review decisions, notation
 *  metadata, the source identity and the project id. Undoing back to
 *  the saved state produces the same fingerprint → clean again.
 */
import type { ScoreDocumentPort } from "./document";
import type { LoadedAudio } from "../import/types";

export interface DirtySourceIdentity {
  readonly originalPath: string;
  readonly contentHash: string;
}

/** The source identity the saved document would record — a loaded
 *  path/recording ref wins (it's what save serializes), otherwise the
 *  project's previously recorded ref (SOURCE_MISSING saves keep the
 *  relink target, #265). */
export function dirtySourceIdentity(
  audio: LoadedAudio | null,
  priorSource: DirtySourceIdentity | null,
): DirtySourceIdentity | null {
  const ref = audio?.ref;
  if (ref?.kind === "path") {
    return { originalPath: ref.path, contentHash: ref.contentHash ?? "" };
  }
  if (ref?.kind === "recording" && ref.path) {
    return { originalPath: ref.path, contentHash: ref.contentHash ?? "" };
  }
  return priorSource ?? null;
}

/** Content fingerprint of the user-facing project state — cheap enough
 *  for the 500 ms dirty poll (no XML bodies or canonical payload are
 *  serialized; revisionId already IS the canonical content hash). */
export function dirtyFingerprint(input: {
  readonly doc: ScoreDocumentPort;
  readonly projectId: string | null;
  readonly audio: LoadedAudio | null;
  readonly priorSource: DirtySourceIdentity | null;
}): string {
  const { doc, projectId, audio, priorSource } = input;
  // Overlay edits sorted by canonical id — insertion order is an
  // undo-history detail, not content.
  const edits = [...doc.noteEdits()]
    .map(
      ([id, e]) =>
        `${id}:${e.pitchDelta}:${e.deleted ? 1 : 0}:${e.enharmonic ? 1 : 0}`,
    )
    .sort();
  const decisions = doc
    .reviewIssues()
    .filter((i) => i.status !== "open")
    .map((i) => `${i.id}:${i.status}`)
    .sort();
  const source = dirtySourceIdentity(audio, priorSource);
  return JSON.stringify({
    // rev-<sha256[:16]> — content-derived; an engine docSwap mints a
    // new one and undo restores the previous one verbatim.
    rev: doc.revisionId,
    edits,
    decisions,
    // Notation metadata + tempo/meter/key state — computeMeta builds a
    // fixed-key object, so stringify is deterministic.
    meta: doc.meta,
    // Path is the durable identity — the recorded contentHash may be
    // the engine-canonical hash while a freshly-loaded ref carries the
    // import-time one (or none); hashing the same file disagrees in
    // shape, not in meaning. A relink to a different path still shows
    // dirty; relinking back to the saved path is honestly clean.
    src: source?.originalPath ?? null,
    projectId: projectId ?? null,
  });
}
