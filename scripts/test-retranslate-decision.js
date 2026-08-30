/**
 * shouldAutoRetranslate() bench — v1.0.8. Tabla de decisión pura, sin
 * Electron. Ver src/services/retranslate-decision.js para la historia de por
 * qué esta condición vive en su propio archivo.
 *
 * El defecto que motiva la ronda (Lyca, Windows, probando v1.0.7):
 *
 *   14:51:12  [Clipboard] Status: stopped      ← pausa: se oculta el overlay
 *   14:53:47  Settings changed while text is on-screen — auto-retranslating…
 *   14:53:47  [Bing] translate: sourceLang=en, targetLang=es
 *
 * Estando en pausa, cambiar el idioma destino mandó la última línea a Bing.
 * El overlay estaba oculto y vaciado desde la pausa, así que ese resultado no
 * lo veía nadie: era tráfico de red y nada más.
 *
 *   node scripts/test-retranslate-decision.js
 *   node scripts/test-retranslate-decision.js --quiet
 */
const path = require('path');
const { shouldAutoRetranslate } = require(path.join('..', 'src', 'services', 'retranslate-decision.js'));

const { makeCheckRegistry, run } = require('./lib/bench.js');
const { check, CHECKS } = makeCheckRegistry();

const BASE = {
  engineChanged: false,
  sourceLangChanged: false,
  targetLangChanged: false,
  promptTemplateChanged: false,
  lastHandledText: 'Valessa: something else is going on here.',
  willBeActive: true
};
const con = (over) => shouldAutoRetranslate({ ...BASE, ...over });

check('el-caso-reportado-en-pausa-un-cambio-de-idioma-no-va-a-la-red', () => {
  return { pass: con({ targetLangChanged: true, willBeActive: false }) === false, actual: null };
}, 'Log 2026-08-30 14:53:47 en Windows, textual: pausa a las 14:51:12 y aun así [Bing] translate dos minutos después.');

check('en-pausa-tampoco-un-cambio-de-motor-o-de-plantilla', () => {
  const casos = [
    con({ engineChanged: true, willBeActive: false }),
    con({ sourceLangChanged: true, willBeActive: false }),
    con({ promptTemplateChanged: true, willBeActive: false })
  ];
  return { pass: casos.every((c) => c === false), actual: casos };
}, 'Los cuatro disparadores entran por la misma puerta — arreglar sólo el del idioma habría dejado tres abiertas.');

check('activo-un-cambio-de-idioma-si-retraduce', () => {
  return { pass: con({ targetLangChanged: true }) === true, actual: null };
}, 'La función de v3.13.12 es real y útil: sin esto, cambiar de motor te deja en pantalla el resultado del motor anterior.');

check('activo-los-otros-tres-disparadores-tambien', () => {
  const casos = [con({ engineChanged: true }), con({ sourceLangChanged: true }), con({ promptTemplateChanged: true })];
  return { pass: casos.every((c) => c === true), actual: casos };
});

check('sin-nada-recordado-no-hay-nada-que-retraducir', () => {
  return { pass: con({ targetLangChanged: true, lastHandledText: '' }) === false, actual: null };
}, 'Guarda que ya existía; desde v1.0.7 además nunca se recuerda texto llegado en pausa.');

check('guardar-sin-cambiar-nada-relevante-no-retraduce', () => {
  return { pass: con({}) === false, actual: null };
}, 'Tocar la opacidad del overlay o el tamaño de fuente no puede disparar una llamada al motor.');

check('apretar-play-y-cambiar-el-idioma-en-el-mismo-guardado-si-retraduce', () => {
  // `willBeActive` es el estado FINAL, no el previo: el bloque que actualiza
  // la bandera corre DESPUÉS en el handler, así que mirar la vieja habría
  // convertido este arreglo en una regresión silenciosa de la función.
  return { pass: con({ targetLangChanged: true, willBeActive: true }) === true, actual: null };
});

check('el-estado-vacio-no-tira-y-decide-que-no', () => {
  const casos = [shouldAutoRetranslate(), shouldAutoRetranslate({}), shouldAutoRetranslate({ lastHandledText: null })];
  return { pass: casos.every((c) => c === false), actual: casos };
}, 'Se llama en cada guardado de ajustes: una excepción acá rompe guardar, no sólo retraducir.');

run('shouldAutoRetranslate() bench', CHECKS);
