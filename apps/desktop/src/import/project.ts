/**
 * Build the `.hornscribe.json` project document (schema v1, FND-001)
 * for the プロジェクトを保存 command (#100).
 *
 * The worker's `project.save` validates this through
 * HornScribeProject.from_dict before writing, so every id here must
 * already satisfy the domain regexes (prj-/rev-/tr-/sn-). Fields the
 * schema does not know (scoreDocument, musicXmlConcert, musicXmlHornF,
 * reviewIssues) ride along as extra keys — preserved verbatim, ignored
 * by the v1 validator, and the data a future project-open restore
 * needs to reconstruct the score without re-transcribing.
 */
import type { LoadedAudio } from "./types";
import type { ScoreDocumentPort } from "../score/document";

/** Fields the app knows at save time. */
export interface ProjectSaveInput {
  readonly audio: LoadedAudio | null;
  readonly doc: ScoreDocumentPort;
  /** Completed job result payload (meta/reviewIssues/scoreDocument). */
  readonly result: unknown;
}

/** `prj-<16hex>` — deterministic content-derived id (ids.py contract). */
export async function deriveProjectId(seed: unknown): Promise<string> {
  // Callers pass a flat object built in fixed key order — plain
  // stringify is deterministic here (same policy as ids.py's canonical
  // JSON digest, minus key sorting which a flat fixed-order object
  // does not need).
  const blob = JSON.stringify(seed);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(blob),
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `prj-${hex.slice(0, 16)}`;
}

function resultMeta(result: unknown): Record<string, unknown> {
  if (typeof result !== "object" || result === null) return {};
  const meta = (result as Record<string, unknown>).meta;
  return typeof meta === "object" && meta !== null
    ? (meta as Record<string, unknown>)
    : {};
}

/** Source ref for the audio backing this score (path-backed only —
 *  browser-dev File refs have no durable path to record). */
function sourceAudioOf(audio: LoadedAudio | null): {
  originalPath: string;
  contentHash: string;
} | null {
  if (!audio) return null;
  const ref = audio.ref;
  if (ref.kind === "path") {
    return { originalPath: ref.path, contentHash: "" };
  }
  if (ref.kind === "recording" && ref.path) {
    return {
      originalPath: ref.path,
      contentHash: ref.contentHash ?? "",
    };
  }
  return null;
}

const REVISION_RE = /^rev-[0-9a-f]{16}$/;
const TRANSCRIPTION_RE = /^tr-[0-9a-f]{16}$/;
const SCORE_NOTE_RE = /^sn-\d{6}$/;

/** True when the document's ids satisfy the v1 schema — a fixture/dev
 *  document (rev-fixture*) cannot be saved and the command should say
 *  so honestly instead of shipping an invalid file. */
export function isSaveableRevision(revisionId: string): boolean {
  return REVISION_RE.test(revisionId);
}

/**
 * Assemble the schema-v1 document. Returns null when the score cannot
 * be represented (non-schema revision id — e.g. the dev fixture doc).
 */
export async function buildProjectDocument(
  input: ProjectSaveInput,
): Promise<Record<string, unknown> | null> {
  const { audio, doc, result } = input;
  if (!isSaveableRevision(doc.revisionId)) return null;
  const meta = resultMeta(result);
  const sourceAudio = sourceAudioOf(audio);

  const transcriptionRevision = meta.transcriptionRevision;
  const transcription =
    typeof transcriptionRevision === "string" &&
    TRANSCRIPTION_RE.test(transcriptionRevision)
      ? {
          backend: String(meta.backend ?? "unknown"),
          backendVersion: String(meta.backendVersion ?? "unknown"),
          settings:
            typeof meta.settings === "object" && meta.settings !== null
              ? meta.settings
              : {},
          revision: transcriptionRevision,
          rawResultRef: `raw/${transcriptionRevision}.json`,
        }
      : null;

  // Canonical-note edits → schema UserEdit records. pitchDelta and
  // deleted are independent facets, so one UI edit can emit two rows.
  const userEdits: Record<string, unknown>[] = [];
  let editSeq = 0;
  for (const [noteId, edit] of doc.noteEdits()) {
    if (!SCORE_NOTE_RE.test(noteId)) continue;
    if (edit.pitchDelta !== 0) {
      userEdits.push({
        id: `ue-${String(++editSeq).padStart(4, "0")}`,
        scoreRevision: doc.revisionId,
        kind: "pitch_change",
        targetNoteIds: [noteId],
        payload: { semitones: edit.pitchDelta },
      });
    }
    if (edit.deleted) {
      userEdits.push({
        id: `ue-${String(++editSeq).padStart(4, "0")}`,
        scoreRevision: doc.revisionId,
        kind: "delete",
        targetNoteIds: [noteId],
        payload: {},
      });
    }
  }

  const reviewDecisions = doc
    .reviewIssues()
    .filter((i) => i.status !== "open")
    .map((i) => ({
      issueId: i.id,
      scoreRevision: doc.revisionId,
      status: i.status,
      note: null,
    }));

  const projectId = await deriveProjectId({
    audioPath: sourceAudio?.originalPath ?? null,
    scoreRevision: doc.revisionId,
    transcriptionRevision: transcriptionRevision ?? null,
  });

  const resultObj =
    typeof result === "object" && result !== null
      ? (result as Record<string, unknown>)
      : {};

  return {
    schemaVersion: 1,
    projectId,
    sourceAudio,
    transcription,
    score: {
      revision: doc.revisionId,
      // The score body travels inline (below); this ref names the
      // canonical cache location a future store would write it to.
      scoreRef: `scores/${doc.revisionId}.json`,
      quantizationSettings:
        typeof meta.settings === "object" && meta.settings !== null
          ? meta.settings
          : {},
    },
    userEdits,
    reviewDecisions,
    uiSession: null,
    // --- preserved extras (ignored by the v1 validator) ---
    scoreDocument: resultObj.scoreDocument ?? null,
    reviewIssues: doc.reviewIssues(),
    musicXmlConcert: doc.musicXml("concert"),
    musicXmlHornF: doc.musicXml("hornF"),
    meta,
  };
}
