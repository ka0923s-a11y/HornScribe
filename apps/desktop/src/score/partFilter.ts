/** #210: drop staves from a serialized MusicXML document so the score
 *  view can show a part subset without a new engine render. Part order
 *  in the XML matches canonical payload.parts order (P1..Pn), and the
 *  kept parts'' hs-* note/rest ids are untouched — overlay, selection,
 *  inspector and playback mapping are unaffected.
 *
 *  Visibility is display-only: muted-ness and audio keep their own
 *  mixer channels — hiding a staff never silences it. */

export function filterScorePartsXml(
  xml: string,
  visible: readonly boolean[],
): string {
  // Fast paths: no mask, or every staff shown — render the document
  // untouched (the common single-part score never enters the DOM pass).
  if (visible.length === 0 || visible.every(Boolean)) return xml;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, "application/xml");
  } catch {
    return xml;
  }
  if (doc.querySelector("parsererror")) return xml;
  const root = doc.documentElement;
  if (root.tagName !== "score-partwise") return xml;
  const scoreParts = root.querySelectorAll("part-list > score-part");
  const parts = Array.from(root.children).filter(
    (el) => el.tagName === "part",
  );
  // Index alignment between <score-part>, <part> and the canonical
  // parts array is the whole contract — if anything disagrees, show
  // the full score rather than hide the wrong staff.
  if (
    parts.length !== scoreParts.length ||
    parts.length !== visible.length ||
    visible.every(Boolean)
  ) {
    return xml;
  }
  const keep = new Set(visible.flatMap((v, i) => (v ? [i] : [])));
  if (keep.size === 0) return xml; // never render an empty score
  parts.forEach((p, i) => {
    if (!keep.has(i)) p.remove();
  });
  scoreParts.forEach((sp, i) => {
    if (!keep.has(i)) sp.remove();
  });
  return new XMLSerializer().serializeToString(doc);
}
