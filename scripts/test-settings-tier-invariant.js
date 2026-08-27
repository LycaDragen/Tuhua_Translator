/**
 * Settings save-model invariant (settings UX audit, v3.13.8x).
 *
 * The rule the "Guardado honesto" rework (see markUnsaved()'s doc comment
 * in renderer.js) depends on: every control that writes a setting is
 * EITHER marked `data-immediate="true"` in index.html (Tier A — applies
 * itself right away, never touches the Save button) OR read inside
 * gatherConfig() (sidebar's "Aplicar y Guardar") or applySettingsModal()
 * (gear modal's "Aplicar") — never both, never neither. "Never both" is
 * the regression this file exists to catch: three real cases of it were
 * found by hand while building this rework (clickThrough, xuatPort,
 * manualTextractorMode all got moved to Tier A but were still ALSO being
 * re-sent by gatherConfig() on every sidebar save) — a control in both
 * places doesn't corrupt data (both paths send the same current DOM
 * value), but it's exactly the kind of silent inconsistency that made the
 * save button lie about whether anything was actually pending, which is
 * the whole defect this rework set out to fix. "Never neither" is
 * defect 1 from the original audit (Temperature/Max Tokens/Top P editable
 * in the modal but saved by neither button) in generalized form.
 *
 * Pure static analysis — reads the two files as text, no Electron, no DOM.
 *
 *   node scripts/test-settings-tier-invariant.js
 *   node scripts/test-settings-tier-invariant.js --quiet
 */
const fs = require('fs');
const path = require('path');

const { makeEagerCheckRegistry } = require('./lib/bench.js');
const { check, report } = makeEagerCheckRegistry();

const htmlPath = path.join(__dirname, '..', 'renderer', 'main', 'index.html');
const jsPath = path.join(__dirname, '..', 'renderer', 'main', 'renderer.js');
const html = fs.readFileSync(htmlPath, 'utf8');
const js = fs.readFileSync(jsPath, 'utf8');

// ─── Extract Tier A ids: any tag carrying data-immediate="true" ────────
// Matches the id="..." on the SAME tag as data-immediate — works whether
// id comes before or after the attribute, single tag on one line (true
// for every control in this file today).
function extractImmediateIds(htmlSrc) {
  const ids = new Set();
  const tagRe = /<[a-zA-Z][^>]*>/g;
  let m;
  while ((m = tagRe.exec(htmlSrc))) {
    const tag = m[0];
    if (!/data-immediate\s*=\s*"true"/.test(tag)) continue;
    const idMatch = tag.match(/\bid\s*=\s*"([a-zA-Z0-9_-]+)"/);
    if (idMatch) ids.add(idMatch[1]);
  }
  return ids;
}

// ─── Extract the body of a named function via brace counting ───────────
// Regex alone can't reliably find a matching closing brace; this walks
// characters from the opening `{` and stops at depth 0. Skips
// strings/template-literals/comments naively (good enough for this file —
// none of the getElementById calls inside these two functions are inside
// a string or comment).
function extractFunctionBody(src, fnName) {
  const startRe = new RegExp('(?:async\\s+)?function\\s+' + fnName + '\\s*\\([^)]*\\)\\s*\\{');
  const m = startRe.exec(src);
  if (!m) throw new Error(`Function ${fnName} not found in source`);
  let depth = 0;
  let i = m.index + m[0].length - 1; // position of the opening '{'
  const start = i;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`Unbalanced braces while extracting ${fnName}`);
}

function extractGetElementByIdIds(fnBody) {
  const ids = new Set();
  const re = /document\.getElementById\(\s*'([a-zA-Z0-9_-]+)'\s*\)/g;
  let m;
  while ((m = re.exec(fnBody))) ids.add(m[1]);
  return ids;
}


// ─── Build the three sets ───────────────────────────────────────────────
const tierAIds = extractImmediateIds(html);
const gatherConfigBody = extractFunctionBody(js, 'gatherConfig');
const applySettingsModalBody = extractFunctionBody(js, 'applySettingsModal');
const tierBSidebarIds = extractGetElementByIdIds(gatherConfigBody);
const tierBModalIds = extractGetElementByIdIds(applySettingsModalBody);

check('tier-a-set-is-non-empty', () => ({
  pass: tierAIds.size >= 10,
  actual: tierAIds.size
}), 'Sanity check on the extractor itself — if this ever reads 0, the regex broke, not the app.');

check('tier-b-sidebar-set-is-non-empty', () => ({
  pass: tierBSidebarIds.size >= 10,
  actual: tierBSidebarIds.size
}), 'Same sanity check for gatherConfig().');

check('tier-b-modal-set-is-non-empty', () => ({
  pass: tierBModalIds.size >= 5,
  actual: tierBModalIds.size
}), 'Same sanity check for applySettingsModal().');

check('no-id-is-both-tier-a-and-gathered-by-sidebar', () => {
  const overlap = [...tierAIds].filter((id) => tierBSidebarIds.has(id));
  return { pass: overlap.length === 0, actual: overlap };
}, 'The exact bug class found by hand for clickThrough/xuatPort/manualTextractorMode: relocating a control to data-immediate but leaving it in gatherConfig() too.');

check('no-id-is-both-tier-a-and-gathered-by-modal', () => {
  const overlap = [...tierAIds].filter((id) => tierBModalIds.has(id));
  return { pass: overlap.length === 0, actual: overlap };
}, 'Same check, for applySettingsModal() — e.g. the overlay fields that moved to saveOverlayImmediate().');

check('no-id-is-gathered-by-both-sidebar-and-modal', () => {
  const overlap = [...tierBSidebarIds].filter((id) => tierBModalIds.has(id));
  return { pass: overlap.length === 0, actual: overlap };
}, 'A setting staged by two different buttons is redundant at best and a sign the control lives in the wrong surface — sidebar and modal should each own a disjoint slice of Tier B.');

// ─── Known Tier A controls that can't carry data-immediate (not an
// input/select/textarea, or dynamically rendered) — documents the
// deliberate gap in extractImmediateIds() rather than silently ignoring
// it. If one of these ever starts appearing in a gather set above, this
// list is what tells a future reader "that would be a real regression."
const KNOWN_TIER_A_NON_MARKED = [
  'lang-select', // uiLanguage — changeLanguage(), button-adjacent select but action-like
  'engine-select', // NOT actually Tier A — onEngineChange() only marks unsaved. Listed
                    // here only as a negative-control comment, not asserted.
];
check('known-non-input-tier-a-controls-are-not-gathered', () => {
  // engine-select is deliberately Tier B (see onEngineChange()'s doc
  // comment) — only lang-select is a genuine Tier A id worth asserting.
  const realCases = ['lang-select'];
  const wronglyGathered = realCases.filter((id) => tierBSidebarIds.has(id) || tierBModalIds.has(id));
  return { pass: wronglyGathered.length === 0, actual: wronglyGathered };
}, 'uiLanguage (#lang-select) auto-saves via changeLanguage() and is not an <input>/<select> inside either gather function by construction — confirms it never regresses into being staged too.');

report();
