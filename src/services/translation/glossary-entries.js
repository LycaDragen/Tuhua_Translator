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

function importEntries(list, data) {
  if (!Array.isArray(data)) throw new Error('Invalid glossary format');
  const next = [...(list || [])];
  let imported = 0;
  for (const item of data) {
    if (item.source && item.target) {
      next.push(createEntry(item));
      imported++;
    }
  }
  return { list: next, imported };
}

module.exports = {
  generateId,
  createEntry,
  addEntry,
  updateEntry,
  removeEntry,
  importEntries
};
