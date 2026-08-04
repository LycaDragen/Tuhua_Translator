/**
 * VNDB Service — Import character names and terms from VNDB.
 *
 * Uses the public VNDB API (https://api.vndb.org/kana) to fetch
 * visual novel metadata including character names, aliases, and
 * staff names. These are then imported as glossary entries so the
 * translation engine preserves proper nouns.
 *
 * v3.11.25: Initial implementation.
 * v3.11.26: Fixed 'alias' → 'aliases' field name (VNDB API uses plural).
 *
 * API Reference: https://api.vndb.org/kana
 * - POST /vn — search visual novels by title
 * - POST /character — search characters by name/vn ID
 *
 * Rate limits: The API allows ~1 request/second for anonymous users.
 * We batch requests and add delays to stay within limits.
 */
const axios = require('axios');
const log = require('electron-log');

const VNDB_API_BASE = 'https://api.vndb.org/kana';

class VndbService {
  constructor() {
    this._client = axios.create({
      baseURL: VNDB_API_BASE,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'TuhuaTranslator/3.11 (github.com/LycaDragen/Tuhua_Translator)'
      }
    });
  }

  /**
   * Search for a visual novel by title.
   * Returns up to 10 matching VN entries with basic info.
   *
   * @param {string} query - Search term (title or partial title)
   * @returns {Promise<Array<{id: string, title: string, alttitle: string|null, aliases: string[]}>>}
   */
  async searchVN(query) {
    if (!query || query.trim().length < 2) return [];

    try {
      const response = await this._client.post('/vn', {
        filters: ['search', '=', query.trim()],
        fields: 'id, title, alttitle, aliases',
        sort: 'searchrank',
        results: 10
      });

      if (!response.data || !response.data.results) return [];

      return response.data.results.map(vn => ({
        id: vn.id,
        title: vn.title || '',
        alttitle: vn.alttitle || null,
        aliases: vn.aliases || []
      }));
    } catch (err) {
      log.error('[VNDB] Search VN error:', err.message);
      return [];
    }
  }

  /**
   * Fetch characters for a specific VN.
   * Returns character entries with names and aliases suitable for glossary import.
   *
   * @param {string} vnId - VNDB VN ID (e.g., "v17")
   * @returns {Promise<Array<{name: string, original: string|null, aliases: string[]}>>}
   */
  async getCharacters(vnId) {
    if (!vnId) return [];

    try {
      const response = await this._client.post('/character', {
        filters: ['vn', '=', ['id', '=', vnId]],
        fields: 'name, original, aliases',
        results: 100
      });

      if (!response.data || !response.data.results) return [];

      return response.data.results.map(ch => ({
        name: ch.name || '',
        original: ch.original || null,
        aliases: this._parseAliases(ch.aliases)
      }));
    } catch (err) {
      log.error('[VNDB] Get characters error:', err.message);
      return [];
    }
  }

  /**
   * Import glossary entries from VNDB for a specific visual novel.
   * Fetches VN title, aliases, character names, and staff names,
   * then converts them to glossary entries.
   *
   * @param {string} vnId - VNDB VN ID (e.g., "v17")
   * @param {object} options
   * @param {boolean} options.includeCharacters - Import character names (default: true)
   * @param {boolean} options.includeTitle - Import VN title/aliases (default: true)
   * @param {string} options.targetLang - Target language for the glossary (default: 'es')
   * @returns {Promise<{entries: Array, stats: {characters: number, titles: number, total: number}}>}
   */
  async importGlossary(vnId, options = {}) {
    const includeCharacters = options.includeCharacters !== false;
    const includeTitle = options.includeTitle !== false;
    const entries = [];
    let characterCount = 0;
    let titleCount = 0;

    try {
      // 1. Fetch VN metadata for title and aliases
      if (includeTitle) {
        const vnResponse = await this._client.post('/vn', {
          filters: ['id', '=', vnId],
          fields: 'id, title, alttitle, aliases',
          results: 1
        });

        if (vnResponse.data && vnResponse.data.results && vnResponse.data.results.length > 0) {
          const vn = vnResponse.data.results[0];

          // Add VN title as a glossary entry (source → same source, preserves it)
          if (vn.title) {
            entries.push({
              source: vn.title,
              target: vn.title,  // Proper nouns stay the same
              mode: 'case-insensitive',
              category: 'vn-title'
            });
            titleCount++;
          }

          // Add alternative title
          if (vn.alttitle && vn.alttitle !== vn.title) {
            entries.push({
              source: vn.alttitle,
              target: vn.alttitle,
              mode: 'case-insensitive',
              category: 'vn-title'
            });
            titleCount++;
          }

          // Add aliases
          for (const alias of (vn.aliases || [])) {
            if (alias && alias.length >= 2 && alias !== vn.title && alias !== vn.alttitle) {
              entries.push({
                source: alias,
                target: alias,
                mode: 'case-insensitive',
                category: 'vn-alias'
              });
              titleCount++;
            }
          }
        }

        // Rate limit delay
        await this._delay(1200);
      }

      // 2. Fetch characters
      if (includeCharacters) {
        const characters = await this.getCharacters(vnId);

        for (const ch of characters) {
          if (!ch.name || ch.name.length < 2) continue;

          // Add the romanized/English name
          entries.push({
            source: ch.name,
            target: ch.name,  // Character names stay as-is in translation
            mode: 'case-insensitive',
            category: 'character'
          });
          characterCount++;

          // Add the original (Japanese) name if different
          if (ch.original && ch.original !== ch.name && ch.original.length >= 2) {
            entries.push({
              source: ch.original,
              target: ch.original,
              mode: 'case-insensitive',
              category: 'character'
            });
            characterCount++;
          }

          // Add aliases (e.g., nicknames, alternate spellings)
          for (const alias of ch.aliases) {
            if (alias && alias.length >= 2 && alias !== ch.name && alias !== ch.original) {
              entries.push({
                source: alias,
                target: alias,
                mode: 'case-insensitive',
                category: 'character-alias'
              });
              characterCount++;
            }
          }
        }
      }

      log.info(`[VNDB] Import complete: ${characterCount} character entries, ${titleCount} title entries for ${vnId}`);

      return {
        entries,
        stats: {
          characters: characterCount,
          titles: titleCount,
          total: entries.length
        }
      };
    } catch (err) {
      log.error('[VNDB] Import glossary error:', err.message);
      throw err;
    }
  }

  /**
   * Parse VNDB aliases into an array.
   * v3.11.26: VNDB API returns aliases as an ARRAY of strings, not a
   * comma-separated string. We handle both formats for robustness.
   * @param {string|string[]|null} aliases
   * @returns {string[]}
   */
  _parseAliases(aliases) {
    if (!aliases) return [];
    // v3.11.26: VNDB API returns arrays directly
    if (Array.isArray(aliases)) {
      return aliases.filter(a => typeof a === 'string' && a.trim().length >= 2);
    }
    // Fallback: comma-separated string (for older API versions or manual input)
    if (typeof aliases === 'string') {
      return aliases
        .split(',')
        .map(a => a.trim())
        .filter(a => a.length >= 2);
    }
    return [];
  }

  /**
   * Simple delay for rate limiting.
   * @param {number} ms
   * @returns {Promise<void>}
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = VndbService;
