/**
 * Glossary entry CRUD — pure array operations, no store dependency.
 *
 * Extracted so the exact same add/update/remove/import logic can operate
 * on either the GLOBAL layer (GlossaryService, backed by electron-store)
 * or the PER-PROFILE layer (a plain array at profile.glossary[], mutated
 * through ProfileStore#update()) without duplicating the entry-shape
 * logic in two places — GlossaryService's own add/update/delete/
 * importFromFile delegate to these same functions.
 */

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 11);
}

function createEntry(entry) {
  return {
    id: generateId(),
    source: entry.source || '',
    target: entry.target || '',
    mode: entry.mode || 'exact',  // 'exact', 'case-insensitive', 'regex'
    enabled: entry.enabled !== undefined ? entry.enabled : true,
    createdAt: Date.now()
  };
}

function addEntry(list, entry) {
  const newEntry = createEntry(entry);
  return { list: [...(list || []), newEntry], entry: newEntry };
}

function updateEntry(list, id, updates) {
  const source = list || [];
  const idx = source.findIndex((e) => e.id === id);
  if (idx === -1) return { list: source, entry: null };
  const updated = { ...source[idx], ...updates, id };
  const next = [...source];
  next[idx] = updated;
  return { list: next, entry: updated };
}

function removeEntry(list, id) {
  return (list || []).filter((e) => e.id !== id);
}

/**
 * A history export (see pipeline.js#_addToHistory) is a JSON array too,
 * shaped { id, original, translated, engine, cached, timestamp } — no
 * `source`/`target` fields, so it silently imported zero entries before
 * this check existed (real feedback: the user picked the wrong file and
 * saw nothing happen, no error at all). Checking only the first item is
 * enough — both exports are homogeneous arrays.
 */
function looksLikeHistoryFile(data) {
  if (!Array.isArray(data) || data.length === 0) return false;
  const sample = data[0];
  return !!sample && typeof sample === 'object' &&
    typeof sample.original === 'string' && typeof sample.translated === 'string' &&
    sample.source === undefined && sample.target === undefined;
}

function importEntries(list, data) {
  if (!Array.isArray(data)) {
    const err = new Error('Invalid glossary format');
    err.code = 'INVALID_FORMAT';
    throw err;
  }
  if (looksLikeHistoryFile(data)) {
    const err = new Error('This file is a translation history export, not a glossary');
    err.code = 'WRONG_CATEGORY_HISTORY';
    throw err;
  }
  const next = [...(list || [])];
  let imported = 0;
  for (const item of data) {
    if (item.source && item.target) {
      next.push(createEntry(item));
      imported++;
    }
  }
  // Not a history file specifically, but still nothing usable in it
  // (wrong JSON shape entirely, e.g. a settings/profile export) — same
  // "nothing happened, no explanation" problem as above, generic message.
  if (imported === 0 && data.length > 0) {
    const err = new Error('No valid glossary entries found in file');
    err.code = 'NO_VALID_ENTRIES';
    throw err;
  }
  return { list: next, imported };
}

module.exports = {
  generateId,
  createEntry,
  addEntry,
  updateEntry,
  removeEntry,
  importEntries,
  looksLikeHistoryFile
};
