/**
 * ¿Corresponde retraducir sola la última línea al guardar ajustes? — v1.0.8
 *
 * Extraído del handler `save-settings` (ipc-handlers.js) por el mismo motivo
 * que `deriveBadgeStatus` salió a badge-state.js: es una decisión pura
 * enterrada dentro de un handler de ipcMain, o sea imposible de ejercitar sin
 * Electron, y ya se equivocó dos veces.
 *
 * Historia de esta condición, que es lo que justifica el archivo:
 *
 *  - v3.13.12 la agrega: cambiar motor/idioma/plantilla retraduce la línea
 *    que el usuario tiene en pantalla, para que no le quede el resultado del
 *    ajuste viejo.
 *  - v1.0.7 arregla que se recordara texto llegado EN PAUSA (esa era la vía
 *    por la que una API key copiada al portapapeles terminó en Google
 *    Translate).
 *  - v1.0.8 (esto) cierra la otra mitad, encontrada por Lyca probando lo
 *    anterior en Windows: estando en pausa, cambiar un ajuste igual mandaba a
 *    la red la última línea YA recordada. El log lo decía sin querer —
 *    "Settings changed while text is on-screen"— cuando la pausa había
 *    ocultado y vaciado el overlay varios minutos antes. Nadie podía ver ese
 *    resultado: era una llamada al motor y nada más.
 *
 * @param {object} state
 * @param {boolean} state.engineChanged
 * @param {boolean} state.sourceLangChanged
 * @param {boolean} state.targetLangChanged
 * @param {boolean} state.promptTemplateChanged
 * @param {string}  state.lastHandledText — '' si no hay nada recordado
 * @param {boolean} state.willBeActive — estado FINAL de la traducción tras
 *   este guardado, no el previo: apretar ▶ y cambiar el idioma pueden venir
 *   en la misma llamada, y la bandera se actualiza más abajo en el handler.
 * @returns {boolean}
 */
function shouldAutoRetranslate(state = {}) {
  const {
    engineChanged = false,
    sourceLangChanged = false,
    targetLangChanged = false,
    promptTemplateChanged = false,
    lastHandledText = '',
    willBeActive = false
  } = state;

  const algoCambio = engineChanged || sourceLangChanged || targetLangChanged || promptTemplateChanged;
  return !!(algoCambio && lastHandledText && willBeActive);
}

module.exports = { shouldAutoRetranslate };
