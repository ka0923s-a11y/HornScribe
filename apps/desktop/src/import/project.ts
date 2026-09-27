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
  /** #222: when re-saving an opened project, keep its identity — a
   *  fresh save derives a new prj- id from the source identity. */
  readonly projectId?: string | null;
  /** #265: the project's recorded source ref — the fallback when no
   *  audio is loaded (SOURCE_MISSING save must not erase the
   *  originalPath/contentHash a later relink verifies against). */
  readonly priorSourceAudio?: {
    originalPath: string;
    contentHash: string;
  } | null;
  /** #12: 区間ラベル — 波形区間の構造ラベル(Aメロ/サビ/ソロ)。
   *  extras として永続化される(バリデータは extras を無視し、
   *  Python 側 model.py も未知キーを extras に残す)。 */
  readonly regionLabels?: Record<string, unknown>[];
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
    return { originalPath: ref.path, contentHash: ref.contentHash ?? "" };
  }
  if (ref.kind === "recording" && ref.path) {
    return { originalPath: ref.path, contentHash: ref.contentHash ?? "" };
  }
  return null;
}

const PROJECT_ID_RE = /^prj-[0-9a-f]{16}$/;
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
  // #243: the engine already streamed a SHA-256 of the source into
  // the canonical payload — prefer that provenance over re-hashing
  // the browser-held bytes a second time.
  const canonical = doc.canonicalDocument?.() as
    Record<string, unknown> | undefined;
  const canonicalHash =
    typeof canonical?.sourceAudioHash === "string"
      ? (canonical.sourceAudioHash as string)
      : null;
  const sourceAudio = sourceAudioOf(audio);
  // #243: never write an empty contentHash — a project saved without
  // a verified source identity cannot reopen or relink. Prefer the
  // engine-recorded hash, then the import-time hash; if neither
  // exists the sourceAudio block is omitted rather than written
  // invalid.
  const sourceAudioResolved =
    sourceAudio == null
      ? // #265: no audio loaded (SOURCE_MISSING) — keep the project's
        // recorded ref so a save does not erase the relink target.
        input.priorSourceAudio &&
        (canonicalHash ?? input.priorSourceAudio.contentHash)
        ? {
            originalPath: input.priorSourceAudio.originalPath,
            contentHash: (canonicalHash ??
              input.priorSourceAudio.contentHash) as string,
          }
        : null
      : (canonicalHash ?? sourceAudio.contentHash)
        ? {
            originalPath: sourceAudio.originalPath,
            contentHash: (canonicalHash ?? sourceAudio.contentHash) as string,
          }
        : null;

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
    } else if (doc.canonicalNoteDeleted?.(noteId)) {
      // #224: an overlay restore on a canonical-deleted note — without
      // this row the saved project would silently keep the delete.
      userEdits.push({
        id: "ue-" + String(++editSeq).padStart(4, "0"),
        scoreRevision: doc.revisionId,
        kind: "restore",
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

  // #222: a project's identity is its source, not the current score
  // revision — edits must not mint a new project id. Re-saving an
  // opened project keeps its recorded id verbatim.
  const projectId =
    input.projectId ??
    (await deriveProjectId({
      audioPath: sourceAudioResolved?.originalPath ?? null,
      audioHash: sourceAudioResolved?.contentHash ?? null,
      title: doc.meta.title,
    }));

  const resultObj =
    typeof result === "object" && result !== null
      ? (result as Record<string, unknown>)
      : {};

  return {
    schemaVersion: 1,
    projectId,
    sourceAudio: sourceAudioResolved,
    transcription,
    score: {
      revision: doc.revisionId,
      quantizationSettings:
        typeof meta.settings === "object" && meta.settings !== null
          ? meta.settings
          : {},
    },
    userEdits,
    reviewDecisions,
    uiSession: null,
    // --- preserved extras (ignored by the v1 validator) ---
    // #115: the LIVE canonical payload — after an engine rhythm edit the
    // document's scoreDocument is newer than the job result's, and saving
    // the stale one would lose the edit on reopen (the XMLs below are
    // already the edited bodies).
    scoreDocument: doc.canonicalDocument?.() ?? resultObj.scoreDocument ?? null,
    reviewIssues: doc.reviewIssues(),
    // #360: still-deferred cap-omitted issues persist verbatim —
    //  expanded ones already ride inside reviewIssues above (with
    //  their decisions), so reopening never loses either half.
    omittedReviewIssues:
      doc.deferredReviewIssues?.() ??
      (Array.isArray(resultObj.omittedReviewIssues)
        ? resultObj.omittedReviewIssues
        : []),
    musicXmlConcert: doc.musicXml("concert"),
    musicXmlHornF: doc.musicXml("hornF"),
    meta,
    // #12: 区間ラベル — extras 領域に載せて開き直しで復元する。
    regionLabels: input.regionLabels ?? [],
  };
}

/* ---------------------- shell-side validation (#389) ----------------------
 * Manual save no longer round-trips through the Python worker, so the
 * shell path carries its own copy of HornScribeProject.from_dict's
 * checks (model.py): schema version, id regexes, and the required-key
 * shape of each nested record. Returns a short reason string, or null
 * when the document is safe to write. Fail closed: any reason aborts
 * the save before a byte reaches disk. */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** The schema-v1 check shared by manual save and autosave (#389). */
export function validateProjectDocument(project: unknown): string | null {
  if (!isRecord(project)) return "project document is not an object";
  const version = project.schemaVersion;
  if (version == null) return "missing required field: schemaVersion";
  if (!Number.isInteger(version)) return "schemaVersion must be an integer";
  if (version !== 1) return `unsupported schemaVersion ${version}`;
  const pid = project.projectId;
  if (typeof pid !== "string" || !PROJECT_ID_RE.test(pid)) {
    return "projectId is missing or malformed";
  }
  const source = project.sourceAudio;
  if (source != null) {
    if (!isRecord(source)) return "sourceAudio is malformed";
    if (
      typeof source.originalPath !== "string" ||
      typeof source.contentHash !== "string"
    ) {
      return "sourceAudio.originalPath/contentHash are required";
    }
  }
  const transcription = project.transcription;
  if (transcription != null) {
    if (!isRecord(transcription)) return "transcription is malformed";
    if (
      typeof transcription.backend !== "string" ||
      typeof transcription.backendVersion !== "string" ||
      typeof transcription.revision !== "string"
    ) {
      return "transcription fields are missing or malformed";
    }
    if (!TRANSCRIPTION_RE.test(transcription.revision)) {
      return "transcription.revision is malformed";
    }
  }
  const score = project.score;
  if (score != null) {
    if (!isRecord(score)) return "score is malformed";
    if (
      typeof score.revision !== "string" ||
      !REVISION_RE.test(score.revision)
    ) {
      return "score.revision is malformed";
    }
  }
  const userEdits = project.userEdits;
  if (userEdits != null && !Array.isArray(userEdits)) {
    return "userEdits must be an array";
  }
  for (const e of userEdits ?? []) {
    if (!isRecord(e)) return "userEdits[] entries must be objects";
    if (
      typeof e.id !== "string" ||
      typeof e.kind !== "string" ||
      typeof e.scoreRevision !== "string" ||
      !REVISION_RE.test(e.scoreRevision)
    ) {
      return "userEdits[].scoreRevision is malformed";
    }
    const ids = e.targetNoteIds;
    if (!Array.isArray(ids)) {
      return "userEdits[].targetNoteIds must be an array";
    }
    for (const n of ids) {
      if (typeof n !== "string" || !SCORE_NOTE_RE.test(n)) {
        return "userEdits[].targetNoteIds contains malformed ID";
      }
    }
  }
  const decisions = project.reviewDecisions;
  if (decisions != null && !Array.isArray(decisions)) {
    return "reviewDecisions must be an array";
  }
  for (const d of decisions ?? []) {
    if (!isRecord(d)) return "reviewDecisions[] entries must be objects";
    if (
      typeof d.issueId !== "string" ||
      typeof d.status !== "string" ||
      typeof d.scoreRevision !== "string" ||
      !REVISION_RE.test(d.scoreRevision)
    ) {
      return "reviewDecisions[].scoreRevision is malformed";
    }
  }
  return null;
}

/** Validate then write through the injected seam — the shared
 *  engine-free save path (#389). `write` is `project_write` in prod;
 *  an invalid document throws before `write` is ever called (fail
 *  closed) and the serialized body is the same JSON.stringify contract
 *  the autosave path writes. */
export async function writeProjectDocument<R>(
  path: string,
  project: Record<string, unknown>,
  write: (path: string, contents: string) => Promise<R>,
): Promise<R> {
  const invalid = validateProjectDocument(project);
  if (invalid != null) {
    throw new Error(`invalid project document: ${invalid}`);
  }
  return write(path, JSON.stringify(project));
}
