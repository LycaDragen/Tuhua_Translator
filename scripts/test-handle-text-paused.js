/**
 * _handleText() en pausa — bench de v1.0.7.
 *
 * El defecto (log real del 2026-08-30): `this._lastHandledText = text` estaba
 * ANTES del corte por pausa, así que con Tuhua pausado el texto entrante
 * igual quedaba guardado. El auto-retraducir de save-settings
 * (ipc-handlers.js:500) lo agarra en cuanto el usuario toca cualquier ajuste
 * — y ahí sale a la red. Lo que pasó de verdad:
 *
 *   04:13:31  el usuario copia su API key de Anthropic → "Translation paused
 *             — skipping text"
 *   04:14:21  cambia un ajuste → auto-retraduce "el último texto" = la key
 *   04:14:22  Anthropic la rechaza (400) → fallback → [Google-Free] translate
 *
 * O sea que la key terminó en Google Translate estando la app en pausa.
 *
 * Corre el método REAL sobre una instancia armada con Object.create() — el
 * constructor de IpcHandlers registra handlers de ipcMain, que no existe
 * fuera de Electron; saltearlo permite ejercitar `_handleText` tal cual se
 * envía, sin reimplementarlo.
 *
 *   node scripts/test-handle-text-paused.js
 *   node scripts/test-handle-text-paused.js --quiet
 */
const path = require('path');
const IpcHandlers = require(path.join('..', 'src', 'main', 'ipc-handlers.js'));

const { makeCheckRegistry, run } = require('./lib/bench.js');
const { check, CHECKS } = makeCheckRegistry();

const KEY = 'sk-ant-api03-uWnRhuqD0NVfL4fLaJ4X2N5-P4s1yk6grvOFsTX3ZyfyxBq';

/**
 * Instancia mínima: sólo los colaboradores que `_handleText` toca de verdad.
 * `translationActive` es lo único que cambia entre los casos de abajo.
 */
function handlers({ translationActive, inputMethod = 'clipboard' }) {
  const settings = { sourceLang: 'en', targetLang: 'es', engine: 'openai', inputMethod, enableRegexFilter: false };
  const traducidos = [];
  const h = Object.create(IpcHandlers.prototype);

  h.store = { get: (key) => (key === undefined ? settings : settings[key]) };
  h.regexFilter = null;               // el camino "servicio no disponible", ya soportado
  h.hookCleaningSettings = { getOptions: () => ({}) };
  h.pipeline = {
    translate: async (text) => { traducidos.push(text); return `[traducido] ${text}`; }
  };
  h.windowManager = {
    hideOutputOverlay() {}, clearOverlayContent() {},
    sendToOutputOverlay() {}, sendToMainWindow() {}
  };
  h._translationActive = translationActive;
  h._lastHandledText = '';
  h._lastSpeakerName = null;
  h._lastHandledHash = '';
  h._lastHandledTime = 0;
  h._lastOcrTextHash = '';

  return { h, traducidos };
}

check('el-caso-reportado-en-pausa-no-se-recuerda-el-texto', async () => {
  const { h, traducidos } = handlers({ translationActive: false });
  await h._handleText(KEY);
  return {
    pass: h._lastHandledText === '' && traducidos.length === 0,
    actual: { lastHandledText: h._lastHandledText, traducidos }
  };
}, 'Si no se recuerda, el auto-retraducir de save-settings (:500) no tiene nada que mandar — su guarda es `&& this._lastHandledText`.');

check('en-pausa-tampoco-se-recuerda-el-hablante', async () => {
  const { h } = handlers({ translationActive: false });
  await h._handleText('Valessa「something else is going on here」');
  return { pass: h._lastSpeakerName === null, actual: h._lastSpeakerName };
}, '_lastSpeakerName viaja junto al texto en la misma llamada de retraducción — dejarlo colgado sería la misma fuga a medias.');

check('activo-si-se-recuerda-el-texto', async () => {
  const { h, traducidos } = handlers({ translationActive: true });
  await h._handleText('Valessa: something else is going on here.');
  return {
    pass: h._lastHandledText === 'Valessa: something else is going on here.' && traducidos.length === 1,
    actual: { lastHandledText: h._lastHandledText, traducidos }
  };
}, 'La retraducción automática al cambiar motor/idioma/plantilla es una función real (v3.13.12) — el arreglo no puede apagarla.');

check('activo-el-hablante-extraido-se-recuerda', async () => {
  const { h } = handlers({ translationActive: true });
  await h._handleText('Valessa「something else is going on here」');
  return { pass: h._lastSpeakerName === 'Valessa' && h._lastHandledText === 'something else is going on here', actual: { speaker: h._lastSpeakerName, text: h._lastHandledText } };
}, 'El nombre se extrae ANTES de los filtros que lo destruirían (Fase 7a) — se recuerda el par (texto sin nombre, nombre), que es lo que necesita la retraducción.');

check('pausar-no-borra-lo-que-ya-se-habia-recordado-estando-activo', async () => {
  const { h } = handlers({ translationActive: true });
  await h._handleText('Ulric: Join the club.');
  h._translationActive = false;
  await h._handleText(KEY);
  return { pass: h._lastHandledText === 'Ulric: Join the club.', actual: h._lastHandledText };
}, 'La línea legítima anterior sigue en pantalla, así que retraducirla al cambiar un ajuste sigue siendo lo correcto — lo que no puede es que la reemplace algo llegado en pausa.');

check('una-linea-sin-contenido-traducible-si-se-recuerda', async () => {
  const { h, traducidos } = handlers({ translationActive: true });
  await h._handleText('!!! 123 ###');
  return { pass: h._lastHandledText === '!!! 123 ###' && traducidos.length === 0, actual: { last: h._lastHandledText, traducidos } };
}, 'Esa rama corta antes de traducir (v3.12.02) pero SÍ manda el texto al overlay — está en pantalla, así que tiene que poder retraducirse.');

run('_handleText() paused bench', CHECKS);
