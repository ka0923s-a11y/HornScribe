import { ja } from "../../strings/ja";

/** Prototype pack TOC — one link per mocked state (issue #31). */
export function IndexPage() {
  const p = ja.prototype;
  const items = [
    { hash: "#/prototype/shell", ...p.pages.shell },
    { hash: "#/prototype/density", ...p.pages.density },
    { hash: "#/prototype/score", ...p.pages.score },
    { hash: "#/prototype/review", ...p.pages.review },
    { hash: "#/prototype/export", ...p.pages.export },
  ];
  return (
    <div className="hs-proto-index">
      <h1 className="hs-proto-index__title">{p.index.title}</h1>
      <p className="hs-proto-index__lead">{p.index.lead}</p>
      <p className="hs-proto-index__note">{p.index.note}</p>
      <ul className="hs-proto-index__list">
        {items.map((item) => (
          <li key={item.hash} className="hs-proto-index__item">
            <a href={item.hash}>
              <span className="hs-proto-index__item-title">{item.title}</span>
              <p className="hs-proto-index__item-desc">{item.desc}</p>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
