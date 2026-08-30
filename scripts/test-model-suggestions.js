/**
 * mergeValidatedModels() bench — v1.0.7.
 *
 * Lo reportado: *"veo que siguen apareciendo sólo 3 modelos después de
 * validar la API key, no aparecen más una vez validados"*. Y era cierto: el
 * botón Validar pedía `GET /v1/models`, contaba cuántos habían vuelto para
 * el aviso ("N modelos") y **tiraba la lista**. El campo Modelo seguía
 * ofreciendo las 3 sugerencias curadas de llm-providers.js, así que el aviso
 * y la lista se contradecían en pantalla.
 *
 * Corre la función REAL sacada de renderer.js (ver lib/renderer-harness.js),
 * no una copia.
 *
 *   node scripts/test-model-suggestions.js
 *   node scripts/test-model-suggestions.js --quiet
 */
const fs = require('fs');
const path = require('path');

const { makeCheckRegistry, run } = require('./lib/bench.js');
const { extractFunction, makeDocument } = require('./lib/renderer-harness.js');
const { check, CHECKS } = makeCheckRegistry();

const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'main', 'renderer.js'), 'utf8');

/** Las 3 de Anthropic en llm-providers.js, que es lo que Lyca veía. */
const CURADAS = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'];

/** Lo que devuelve /v1/models de Anthropic: las curadas + bastante más. */
const DE_LA_API = [
  'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5',
  'claude-opus-4-1', 'claude-sonnet-4', 'claude-3-7-sonnet-latest', 'claude-3-haiku-20240307'
];

function harness(curadas = CURADAS) {
  const document = makeDocument();
  const input = document.createElement('input');
  input.id = 'llm-model';
  input.dataset.models = JSON.stringify(curadas);
  document.body.appendChild(input);

  const mergeValidatedModels = new Function('document',
    `${extractFunction(rendererSrc, 'mergeValidatedModels')}; return mergeValidatedModels;`)(document);

  return { input, mergeValidatedModels, models: () => JSON.parse(input.dataset.models) };
}

check('lo-reportado-tras-validar-aparecen-todos-los-modelos', () => {
  const h = harness();
  h.mergeValidatedModels({ valid: true, models: DE_LA_API });
  const out = h.models();
  return { pass: out.length === 8 && out.includes('claude-fable-5') && out.includes('claude-3-7-sonnet-latest'), actual: out };
}, 'La respuesta de la API ya estaba en la mano — sólo se usaba para contar.');

check('las-curadas-quedan-primero', () => {
  const h = harness();
  h.mergeValidatedModels({ valid: true, models: DE_LA_API });
  return { pass: h.models().slice(0, 3).join(',') === CURADAS.join(','), actual: h.models() };
}, 'Son las recomendadas para traducir línea por línea (precio/latencia); la lista de la API trae de todo, incluidos modelos que no sirven para esto.');

check('no-se-duplica-un-modelo-que-esta-en-las-dos-listas', () => {
  const h = harness();
  h.mergeValidatedModels({ valid: true, models: DE_LA_API });
  const out = h.models();
  const dups = out.filter((m, i) => out.indexOf(m) !== i);
  return { pass: dups.length === 0, actual: dups };
}, 'Las 3 curadas también vienen en la respuesta de la API — sin dedup aparecerían dos veces cada una.');

check('validar-dos-veces-no-vuelve-a-agregar-nada', () => {
  const h = harness();
  h.mergeValidatedModels({ valid: true, models: DE_LA_API });
  const despuesDeUna = h.models().length;
  h.mergeValidatedModels({ valid: true, models: DE_LA_API });
  return { pass: h.models().length === despuesDeUna, actual: { despuesDeUna, despuesDeDos: h.models().length } };
}, 'El botón Validar se aprieta varias veces mientras uno prueba una key — la lista no puede crecer sola.');

check('una-validacion-fallida-no-toca-la-lista', () => {
  const h = harness();
  h.mergeValidatedModels({ valid: false, models: DE_LA_API });
  return { pass: h.models().join(',') === CURADAS.join(','), actual: h.models() };
}, 'Una key inválida no dice nada sobre qué modelos existen.');

check('un-proveedor-que-no-devuelve-modelos-no-rompe-nada', () => {
  const h = harness();
  const casos = [{ valid: true }, { valid: true, models: [] }, { valid: true, models: null }, null, undefined];
  let threw = null;
  for (const c of casos) {
    try { h.mergeValidatedModels(c); } catch (e) { threw = e.message; }
  }
  return { pass: threw === null && h.models().join(',') === CURADAS.join(','), actual: { threw, models: h.models() } };
}, 'DeepL/LibreTranslate/Custom-MT pasan por el mismo botón y devuelven `{valid, code, params}` sin `models`.');

check('un-dataset-corrupto-no-tira', () => {
  const h = harness();
  h.input.dataset.models = 'esto no es JSON';
  let threw = null;
  try { h.mergeValidatedModels({ valid: true, models: DE_LA_API }); } catch (e) { threw = e.message; }
  return { pass: threw === null && h.models().length === DE_LA_API.length, actual: { threw, models: h.models() } };
}, 'JSON.parse sobre un dataset ajeno es la clase de cosa que tira una excepción y deja el panel a medio pintar.');

check('las-dos-mitades-estan-atadas-validar-devuelve-modelos-y-el-panel-los-usa', () => {
  // Misma disciplina que el check de extraHeaders en test-llm-providers.js:
  // el bug original NO era la función, era que la respuesta se tiraba. Si
  // alguien saca el `models` del handler, o deja de llamar a
  // mergeValidatedModels() después de validar, esto falla.
  const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc-handlers.js'), 'utf-8');
  const devuelveModelos = /code: 'openai_key_valid'[\s\S]{0,120}?models\s*[,}]/.test(ipcSrc);
  const loUsa = /const result = await api\.validateApiKey\([\s\S]{0,200}?mergeValidatedModels\(result\)/.test(rendererSrc);
  return { pass: devuelveModelos && loUsa, actual: { handlerDevuelveModelos: devuelveModelos, validateApiKeyLosUsa: loUsa } };
});

run('mergeValidatedModels() bench', CHECKS);
