// Deterministic per-page analysis shared by the crawler (screenshot crops) and the blueprint builder.
import { computeEffective } from './tree.mjs';
import { detectSections, findRepeats, classify } from './sections.mjs';

export function analyzeSections(raw) {
  const eff = computeEffective(raw.tree);
  const vh = (raw.viewport && raw.viewport.h) || 900;
  const nodes = detectSections(raw.tree, vh);
  const total = nodes.length;
  const prev = [];
  const sections = nodes.map((node, index) => {
    const repeats = findRepeats(node);
    const c = classify({ node, index, repeats }, { eff, total, vh, prev });
    prev.push(c.type);
    return { node, index, repeats, type: c.type, heading: c.heading, features: c.features };
  });
  return { eff, sections };
}
