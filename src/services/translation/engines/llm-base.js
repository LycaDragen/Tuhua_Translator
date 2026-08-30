/**
 * OpenAI-compatible chat completions engine — shared base for any provider
 * that speaks the `/chat/completions` API shape (OpenAI itself, Ollama/
 * LM Studio/llama.cpp/KoboldCpp locally, and — per the LLM engine overhaul
 * plan — OpenRouter/DeepSeek/Gemini/Anthropic/Groq via their OpenAI
 * compatibility layers later on).
 *
 * v3.13.56 (LLM engine overhaul, Fase 1): extracted from openai.js and
 * local-llm.js, which were ~95% identical — prompt text included — down to
 * the same typo-prone bugs having to be fixed twice (see v3.13.55's Fase 0).
 * This is a pure refactor: request shape, prompt text, few-shot logic, and
 * response parsing are all unchanged from what those two files did before.
 * `openai.js` and `local-llm.js` are now thin subclasses that just fix the
 * provider-specific constructor values (name, auth, default timeout, model,
 * baseUrl, supportedLanguages).
 */
const axios = require('axios');
const { sanitizeLLMOutput, LLMRefusalError, LLMPassthroughError } = require('../llm-output');
const { getRequestParamOverrides, normalizeBaseUrl } = require('../llm-providers');
const { renderPromptTemplate } = require('../prompt-template');
const { DEFAULT_TEMPLATE } = require('../prompt-presets');
const { getFewshotExamples } = require('../fewshot-examples');

class OpenAICompatEngine {
  constructor({
    name,
    displayName,
    requiresKey = false,
    apiKey = '',
    model,
    baseUrl,
    // v3.13.59 (Fase 4): renamed from `systemPrompt` — '' means "use
    // prompt-presets.js's DEFAULT_TEMPLATE", same empty-means-default
    // convention as before, but no longer destructive when non-empty (see
    // translate() below: the old code did `this.systemPrompt ||
    // defaultPrompt`, a straight replacement that dropped the language
    // names and disabled few-shot the moment a user typed anything).
    promptTemplate = '',
    timeout = 30000,
    supportedLanguages = [],
    httpClient = axios,
    // v3.13.57 (Fase 2): the `llmSanitize` rollback interruptor — default
    // on. Set false to fall back to the pre-Fase-2 behavior of a bare
    // `.trim()` with none of sanitizeLLMOutput's heuristics, in case one of
    // them misfires on a real setup in a way the ground-truth bench didn't
    // catch.
    sanitize = true,
    // v3.13.58 (Fase 3): `providerId` is looked up in llm-providers.js at
    // request-build time (not resolved once in the constructor) so that
    // changing `model` between calls — e.g. a user picks o4-mini after
    // starting on gpt-4o-mini — always re-evaluates whether it's a
    // reasoning model. `providerId` is undefined for local-llm (no
    // provider table entry; local servers get the plain defaults).
    providerId,
    temperature = 0.3,
    maxTokens = 1500,
    // v3.13.58: unset (not 0) by default — top_p is a real sampling
    // parameter with meaningful behavior at 0, so "not sent" and "sent as
    // 0" must be distinguishable. null/undefined means "don't send it".
    topP = null,
    // v3.13.59 (Fase 4): decoupled from whether a custom promptTemplate is
    // set — the OLD coupling (`if (!this.systemPrompt)`) is exactly what
    // silently killed few-shot for anyone who customized the prompt.
    fewShotEnabled = true
  } = {}) {
    this.name = name;
    this.displayName = displayName;
    this.requiresKey = requiresKey;
    this.apiKey = apiKey;
    this.model = model;
    // v1.0.5: normalizado, no crudo — ver setBaseUrl() abajo y
    // normalizeBaseUrl() en llm-providers.js. Aquí también, porque un
    // endpoint puede llegar por el constructor sin pasar nunca por el setter.
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.promptTemplate = promptTemplate;
    this.timeout = timeout;
    this.supportedLanguages = supportedLanguages;
    this.sanitize = sanitize;
    this.providerId = providerId;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.topP = topP;
    this.fewShotEnabled = fewShotEnabled;
    // Injectable so scripts/test-llm-base.js can assert on the exact request
    // body/headers without making a real HTTP call — same idea as the
    // injectable `store` in glossary.js/profile-store.js.
    this._httpClient = httpClient;
    // v3.13.19: Context is owned by the pipeline's ContextMemory, passed in
    // via options.context — see context-memory.js.
    //
    // v3.13.56: `capabilities` is what pipeline.js will read once Fase 5
    // lands (glossary-as-prompt, abort/streaming) instead of hardcoding
    // engine names in a list — see the now-deleted `LLM_ENGINES` array
    // this replaces the intent of. v3.13.6x (Fase 9): `abort` is now true
    // — translate() forwards options.signal straight to axios below, so a
    // pipeline that aborts a stale request actually cancels the HTTP call
    // instead of just discarding a promise nobody awaits. Full streaming
    // was considered and deliberately NOT done for this same Fase — see
    // the plan's registered objection (whole-output sanitizer, no render
    // surface, small benefit for 20-40 token VN lines).
    //
    // v3.13.59 (Fase 4): `context` changed from 'chat-turns' to
    // 'prompt-template' — the real conversation context (recent game
    // dialogue) now renders into the system prompt text via
    // {contextBoth}/{contextOriginal}/{contextTranslation} instead of
    // being injected as fake user/assistant turns. Few-shot EXAMPLES
    // (fewshot-examples.js) still go in as real chat turns — those are
    // illustrative teaching pairs, not prior dialogue, and turn-based
    // few-shot is a well-established prompting technique independent of
    // this change. See translate() below for exactly where each lives.
    this.capabilities = { prompt: true, context: 'prompt-template', glossaryPrompt: true, abort: true };
  }

  async translate(text, options = {}) {
    const { sourceLang = 'ja', targetLang = 'es', sourceLangName = sourceLang, targetLangName = targetLang } = options;

    if (this.requiresKey && !this.apiKey) {
      throw new Error(`${this.displayName} API key is required`);
    }

    // v3.13.59 (Fase 4): {game}/{vnTitle}/{speaker}/{glossary} are Fase
    // 5/7 concerns — pipeline.js doesn't pass them yet, so they simply
    // come through as undefined here and their template line collapses
    // (see prompt-template.js's AUTO_COLLAPSIBLE_VARS). Nothing in this
    // file needs to change when those Fases wire real values through
    // `options` — only pipeline.js's call site does.
    const ocrNote = options.inputMethod === 'ocr'
      ? ' Recognition errors are possible — if a word looks garbled, infer the most likely intended reading rather than transcribing the garble.'
      : '';
    const rendered = renderPromptTemplate(this.promptTemplate || DEFAULT_TEMPLATE, {
      sentence: text,
      srclang: sourceLangName,
      tgtlang: targetLangName,
      srclangcode: sourceLang,
      tgtlangcode: targetLang,
      context: options.context || [],
      glossary: options.glossary,
      game: options.game,
      vnTitle: options.vnTitle,
      speaker: options.speaker,
      inputMethod: options.inputMethod,
      ocrNote
    });
    if (rendered.warnings.length) {
      // Same "never apply/skip in silence" discipline as the sanitizer
      // below — an unknown {variable} in a user-edited template is a typo
      // the user can only find by reading a log.
      console.warn(`[Prompt template] ${this.displayName}: ${rendered.warnings.join('; ')}`);
    }

    const messages = [{ role: 'system', content: rendered.text }];

    // Few-shot examples — real chat turns, independent of whether the
    // template is custom (see fewShotEnabled's own doc comment above for
    // why this is no longer coupled to promptTemplate being non-empty).
    // Skipped when the template embeds {sentence}: that's a completion-style
    // template (see the block below) with no trailing `user` turn, so
    // appending few-shot pairs would leave the conversation ending on an
    // `assistant` turn with nothing asking the model to respond — verified
    // against a real local server, this reliably produces an empty
    // completion (finish_reason 'stop', content '') rather than an error,
    // which made it silent until traced deliberately.
    if (this.fewShotEnabled && !rendered.containsSentence) {
      for (const example of getFewshotExamples(sourceLang, targetLang)) {
        messages.push({ role: 'user', content: example.user });
        messages.push({ role: 'assistant', content: example.assistant });
      }
    }

    // v3.13.59: the line to translate rides in the system prompt itself
    // ONLY if the template explicitly references {sentence} (a power-user
    // escape hatch for a completion-style template) — otherwise it's
    // appended here as the final `user` turn, same as every template
    // shipped with Tuhua (none of the four presets reference {sentence}).
    // This — not a hardcoded "Input: {TEXT}" — is what v3.13.55's Fase 0
    // fix pointed at doing properly.
    if (!rendered.containsSentence) {
      messages.push({ role: 'user', content: text });
    }

    const headers = { 'Content-Type': 'application/json' };
    // v3.13.56: only send Authorization when there's actually a key to send.
    // openai.js always had one (requiresKey throws above if not), but
    // local-llm.js never sent this header at all — some local servers (LM
    // Studio with its optional auth toggle, notably) reject a Bearer header
    // with an empty token rather than just ignoring it, so "send an empty
    // Bearer" is not equivalent to "send nothing".
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    // v3.13.58 (Fase 3): some models (OpenAI's o-series, DeepSeek's
    // deepseek-reasoner) reject a custom temperature/top_p outright, and
    // OpenAI's reasoning models specifically want `max_completion_tokens`
    // instead of `max_tokens` — getRequestParamOverrides() is the single
    // place that table of exceptions lives (llm-providers.js), so a new
    // provider/model quirk is a data change there, not a new branch here.
    const { maxTokensField, omitSamplingParams } = getRequestParamOverrides(this.providerId, this.model);
    const body = {
      model: this.model,
      messages: messages,
      [maxTokensField]: this.maxTokens
    };
    if (!omitSamplingParams) {
      body.temperature = this.temperature;
      if (this.topP !== null && this.topP !== undefined) {
        body.top_p = this.topP;
      }
    }

    // v3.13.6x (Fase 9): options.signal is undefined for any caller that
    // doesn't pass one (a bare bench, translateNow() call sites that
    // predate this) — axios treats an undefined `signal` as "no abort
    // wiring", so this is a no-op change for anyone not threading one
    // through, not a new required parameter.
    const response = await this._httpClient.post(
      `${this.baseUrl}/chat/completions`,
      body,
      { timeout: this.timeout, headers, signal: options.signal }
    );

    const rawContent = response.data?.choices?.[0]?.message?.content;
    if (!rawContent || !rawContent.trim()) {
      // v1.0.5: un modelo de razonamiento servido por Ollama gasta su
      // presupuesto de tokens en un bloque de pensamiento que NO viaja en
      // `content` — la respuesta llega con finish_reason 'length',
      // usage.completion_tokens al tope y el texto vacío. Medido contra
      // Ollama 0.32.15 con LFM2.5-8B-A1B: 300 tokens gastados, content ''.
      //
      // Sin esta rama el usuario ve "Empty ... response", que no dice ni qué
      // pasó ni qué hacer — y el modelo SÍ trabajó, sólo que hacia dentro.
      // Misma disciplina que el ECONNREFUSED ::1 de v1.0.4: el error tiene
      // que apuntar a la causa, porque el síntoma no lo hace.
      //
      // Para quien venga buscando el arreglo fácil: el `"think": false` de la
      // API nativa de Ollama NO lo desactiva (probado en 0.32.15). La salida
      // real es subir el límite de tokens o cambiar de modelo.
      const spentTokens = response.data?.usage?.completion_tokens || 0;
      const emptyFinishReason = response.data?.choices?.[0]?.finish_reason || null;
      if (emptyFinishReason === 'length' && spentTokens > 0) {
        throw new Error(
          `${this.displayName} spent ${spentTokens} tokens without returning any text — `
          + 'this looks like a reasoning/thinking model. Raise the token limit or pick a model without reasoning.'
        );
      }
      throw new Error(`Empty ${this.displayName} response`);
    }

    if (!this.sanitize) {
      // Pre-Fase-2 behavior, kept reachable via the llmSanitize setting.
      return { text: rawContent.trim(), detectedLang: null, engine: this.name };
    }

    const finishReason = response.data?.choices?.[0]?.finish_reason || null;
    const sanitized = sanitizeLLMOutput(rawContent, {
      sourceText: text,
      sourceLangCode: sourceLang,
      targetLangCode: targetLang,
      finishReason
    });

    if (sanitized.actions.length) {
      // v3.13.57: never apply a sanitizer intervention in silence — same
      // discipline as TUHUA_STDOUT_RAWDUMP (v3.13.29): if this needs
      // diagnosing later, it can only be diagnosed from a real log.
      const level = sanitized.verdict === 'ok' ? 'log' : 'warn';
      console[level](`[LLM sanitize] ${this.displayName} (${sanitized.verdict}): ${sanitized.actions.join(', ')}`);
    }

    if (sanitized.verdict === 'refusal') {
      throw new LLMRefusalError(`${this.displayName} refused to translate`);
    }
    if (sanitized.verdict === 'passthrough') {
      throw new LLMPassthroughError(`${this.displayName} returned the source text untranslated`);
    }

    return {
      text: sanitized.text,
      detectedLang: null,
      engine: this.name,
      // v3.13.57: read by pipeline.js to skip caching/TM/context for a
      // response that was cut off by max_tokens — see the comment there.
      // Absent (undefined, falsy) for the normal 'ok' case.
      truncated: sanitized.verdict === 'truncated'
    };
  }

  setApiKey(key) {
    this.apiKey = key;
  }

  setBaseUrl(url) {
    // v1.0.5: la barra final se quita AQUÍ y no en el call site porque el
    // `${this.baseUrl}/chat/completions` de translate() es una concatenación
    // cruda: un `/v1/` guardado produce `/v1//chat/completions`, que Ollama
    // contesta con un 307 y deja morir el POST. Ver normalizeBaseUrl().
    this.baseUrl = normalizeBaseUrl(url);
  }
}

module.exports = OpenAICompatEngine;
