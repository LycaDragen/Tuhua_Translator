/**
 * Fuzzy Matcher — Text similarity algorithms for Translation Memory.
 *
 * Provides multiple similarity strategies:
 *   - Levenshtein distance ratio (edit-distance based)
 *   - Jaccard word-set similarity (token overlap)
 *   - N-gram similarity (character n-gram overlap)
 *   - Combined score (weighted average of all methods)
 *
 * Inspired by LunaTranslator's fuzzy matching approach for
 * repetitive VN dialogue with minor OCR/text variations.
 *
 * v3.11.25: Extracted as a standalone module so both Translation Memory
 * and OCR can share the same similarity algorithms without coupling.
 */

/**
 * Compute Levenshtein edit distance between two strings.
 * Optimized for space — uses two rows instead of full matrix.
 * @param {string} a
 * @param {string} b
 * @returns {number} edit distance
 */
function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  // Ensure a is the shorter string for less memory usage
  if (a.length > b.length) [a, b] = [b, a];

  let prevRow = new Array(a.length + 1);
  let currRow = new Array(a.length + 1);

  for (let i = 0; i <= a.length; i++) prevRow[i] = i;

  for (let j = 1; j <= b.length; j++) {
    currRow[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[i] = Math.min(
        currRow[i - 1] + 1,        // insertion
        prevRow[i] + 1,             // deletion
        prevRow[i - 1] + cost       // substitution
      );
    }
    [prevRow, currRow] = [currRow, prevRow];
  }

  return prevRow[a.length];
}

/**
 * Levenshtein similarity ratio (0-1).
 * 1 = identical, 0 = completely different.
 * @param {string} a
 * @param {string} b
 * @returns {number} 0..1
 */
function levenshteinSimilarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;

  const maxLen = Math.max(a.length, b.length);
  const dist = levenshteinDistance(a, b);
  return 1 - dist / maxLen;
}

/**
 * Jaccard similarity on word sets.
 * Tokenizes both strings into word sets and computes intersection/union.
 * Good for detecting reordered or partially matching sentences.
 * @param {string} a
 * @param {string} b
 * @returns {number} 0..1
 */
function jaccardWordSimilarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;

  const setA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 0));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 0));

  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * N-gram similarity (character level).
 * Splits both strings into n-gram sets and computes Jaccard overlap.
 * Good for detecting fuzzy matches in CJK text where word boundaries
 * are ambiguous.
 * @param {string} a
 * @param {string} b
 * @param {number} n - gram size (default 2 = bigrams)
 * @returns {number} 0..1
 */
function ngramSimilarity(a, b, n = 2) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;

  const ngramsA = _getNgrams(a, n);
  const ngramsB = _getNgrams(b, n);

  if (ngramsA.size === 0 && ngramsB.size === 0) return 1;
  if (ngramsA.size === 0 || ngramsB.size === 0) return 0;

  let intersection = 0;
  for (const ng of ngramsA) {
    if (ngramsB.has(ng)) intersection++;
  }

  const union = ngramsA.size + ngramsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Generate n-gram set from a string.
 * @param {string} text
 * @param {number} n
 * @returns {Set<string>}
 */
function _getNgrams(text, n) {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const ngrams = new Set();
  for (let i = 0; i <= normalized.length - n; i++) {
    ngrams.add(normalized.substring(i, i + n));
  }
  return ngrams;
}

/**
 * Combined fuzzy similarity — weighted average of multiple methods.
 *
 * Weight distribution:
 *   - Levenshtein: 40% (best for small typos, OCR errors)
 *   - Jaccard words: 30% (best for word reordering, partial matches)
 *   - N-gram: 30% (best for CJK text without word boundaries)
 *
 * For short text (< 5 chars), uses only Levenshtein since
 * Jaccard and n-gram are unreliable on very short strings.
 *
 * @param {string} a - Source text
 * @param {string} b - Candidate text
 * @returns {number} 0..1 similarity score
 */
function combinedSimilarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;

  // For very short strings, Levenshtein is the most reliable
  if (a.length < 5 || b.length < 5) {
    return levenshteinSimilarity(a, b);
  }

  const lev = levenshteinSimilarity(a, b);
  const jac = jaccardWordSimilarity(a, b);
  const ng = ngramSimilarity(a, b);

  return (lev * 0.4) + (jac * 0.3) + (ng * 0.3);
}

/**
 * Find the best fuzzy match for a source text from a list of candidates.
 *
 * @param {string} sourceText - The text to find a match for
 * @param {Array<{text: string, translation: string, metadata?: object}>} candidates - Known translations
 * @param {number} threshold - Minimum similarity to consider a match (0..1, default 0.75)
 * @returns {{ match: object|null, score: number }} Best match above threshold, or null
 */
function findBestMatch(sourceText, candidates, threshold = 0.75) {
  if (!sourceText || candidates.length === 0) return { match: null, score: 0 };

  let bestMatch = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const score = combinedSimilarity(sourceText, candidate.text);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = candidate;
    }
  }

  if (bestScore >= threshold) {
    return { match: bestMatch, score: bestScore };
  }

  return { match: null, score: bestScore };
}

module.exports = {
  levenshteinDistance,
  levenshteinSimilarity,
  jaccardWordSimilarity,
  ngramSimilarity,
  combinedSimilarity,
  findBestMatch
};
