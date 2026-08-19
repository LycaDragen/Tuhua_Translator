/**
 * Few-shot examples for LLM translation engines — LLM engine overhaul,
 * Fase 4.
 *
 * Before this, few-shot was a single hardcoded `if` in openai.js covering
 * exactly two pairs (ja->es, ja->en), keyed on comparing the ENGLISH NAME
 * of the language ('Japanese' === sourceLangName) rather than the
 * language CODE — and it was wired to `if (!this.systemPrompt)`, so
 * writing a custom prompt silently turned few-shot off. Neither of those
 * survives here: this is keyed by code pair, and llm-base.js gates it on
 * its OWN `fewShotEnabled` setting, independent of whatever the prompt
 * template is.
 *
 * Each pair gets 2 short examples chosen to demonstrate something the
 * RULES text alone doesn't reliably teach small/local models: an
 * honorific/title staying untranslated, and a fragment or interjection
 * translated as a fragment rather than completed into a full sentence.
 * Not an exhaustive matrix of every language pair Tuhua supports — a
 * missing pair just means zero-shot, same as every pair not in the old
 * two-entry `if` already worked.
 *
 * Pure data, no I/O, no Electron.
 */

const FEWSHOT_EXAMPLES = {
  'ja->es': [
    { user: 'こんにちは、元気？', assistant: 'Hola, ¿cómo estás?' },
    { user: '先輩、待って', assistant: 'Senpai, espera' }
  ],
  'ja->en': [
    { user: 'こんにちは、元気？', assistant: 'Hello, how are you?' },
    { user: 'お兄ちゃん…', assistant: 'Onii-chan…' }
  ],
  'zh->es': [
    { user: '你好，最近怎么样？', assistant: 'Hola, ¿cómo has estado?' },
    { user: '林小姐，早上好', assistant: 'Buenos días, señorita Lin' }
  ],
  'ko->en': [
    { user: '안녕하세요, 잘 지내세요?', assistant: 'Hello, how have you been?' },
    { user: '오빠…', assistant: 'Oppa…' }
  ],
  'en->es': [
    { user: "I can't believe you did that.", assistant: 'No puedo creer que hayas hecho eso.' },
    { user: 'Wait—', assistant: 'Espera—' }
  ]
};

/**
 * @param {string} sourceLangCode
 * @param {string} targetLangCode
 * @returns {Array<{user: string, assistant: string}>} empty if no examples for this pair
 */
function getFewshotExamples(sourceLangCode, targetLangCode) {
  return FEWSHOT_EXAMPLES[`${sourceLangCode}->${targetLangCode}`] || [];
}

module.exports = { FEWSHOT_EXAMPLES, getFewshotExamples };
