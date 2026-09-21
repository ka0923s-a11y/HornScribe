import { ja } from "../strings/ja";

/**
 * Properties (Inspector) placeholder — opens only on selection in the real
 * app (GUI_UX_SPEC §6); always visible in this spike to exercise layout,
 * theming and focus order. Collapses under 1200px per §21.
 */
export function PropertiesPanel() {
  return (
    <aside className="hs-properties" aria-label={ja.properties.regionLabel}>
      <h2 className="hs-properties__title">{ja.properties.title}</h2>
      <p className="hs-properties__body">{ja.properties.placeholder}</p>
    </aside>
  );
}
