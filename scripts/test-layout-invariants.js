/**
 * Invariantes de layout que una regresión de CSS rompe en silencio — v1.0.8.
 *
 * Un test de layout de verdad necesita un navegador midiendo cajas, y eso ya
 * se hace a mano contra un Electron real (ver
 * [[capability-electron-runs-in-wsl]] en las notas del proyecto: se levanta
 * la app, se arrastra el sidebar con Input.dispatchMouseEvent y se comparan
 * getBoundingClientRect antes/después). Lo que hace este archivo es más
 * modesto y complementario: fijar estáticamente las decisiones de CSS que
 * costaron un bug reportado, para que sacarlas falle acá en vez de
 * descubrirse otra vez en la máquina de un usuario.
 *
 * Si alguna de estas filas se rehace con otra técnica (grid, por ejemplo),
 * hay que ACTUALIZAR el check, no borrarlo: lo que se está fijando es "esto
 * no puede desbordar al angostarse", no "tiene que usar flexbox".
 *
 *   node scripts/test-layout-invariants.js
 *   node scripts/test-layout-invariants.js --quiet
 */
const fs = require('fs');
const path = require('path');

const { makeCheckRegistry, run } = require('./lib/bench.js');
const { check, CHECKS } = makeCheckRegistry();

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'main', 'index.html'), 'utf8');

/** La etiqueta de apertura del elemento que CONTIENE al id dado. */
function contenedorDe(src, id) {
  const i = src.indexOf(`id="${id}"`);
  if (i === -1) throw new Error(`no encontré id="${id}" en index.html`);
  const aperturaHija = src.lastIndexOf('<', i);
  // La apertura del padre es el '<div' anterior a la etiqueta de la hija.
  const aperturaPadre = src.lastIndexOf('<div', aperturaHija - 1);
  if (aperturaPadre === -1) throw new Error(`no encontré el contenedor de #${id}`);
  return src.slice(aperturaPadre, src.indexOf('>', aperturaPadre) + 1);
}

check('el-bug-reportado-la-fila-del-badge-y-los-botones-se-reacomoda', () => {
  // Lyca, Windows, v1.0.7: "cuando se disminuye el espacio que tiene la
  // columna de la derecha, los botones salen de su contenedor visualmente en
  // lugar de reordenarse". Reproducido en un Electron real arrastrando el
  // sidebar: sin `flex-wrap`, el badge de estado ("Modo OCR") se ENCIMA con
  // el botón Logs — una fila flex sin wrap no encoge más allá del contenido
  // mínimo de sus hijos. Se notó con el tercer botón (Reportar), pero el
  // defecto existía desde que eran dos: sólo hacía falta menos ancho.
  const fila = contenedorDe(html, 'connection-badge-bottom');
  const esFlex = /\bflex\b/.test(fila);
  const envuelve = /\bflex-wrap\b/.test(fila);
  return { pass: esFlex && envuelve, actual: fila };
});

check('las-dos-mitades-de-esa-fila-pueden-encogerse', () => {
  // `min-w-0` es la otra mitad del arreglo: por defecto un hijo flex no baja
  // de su min-content, que es lo que empuja a uno sobre el otro antes de que
  // el wrap llegue a actuar.
  const badge = html.slice(html.indexOf('id="connection-badge-bottom"'));
  const aperturaBadge = html.slice(html.lastIndexOf('<div', html.indexOf('id="connection-badge-bottom"')), html.indexOf('>', html.indexOf('id="connection-badge-bottom"')) + 1);
  const filaBotones = badge.slice(badge.indexOf('</div>'));
  const aperturaBotones = filaBotones.slice(filaBotones.indexOf('<div'), filaBotones.indexOf('>', filaBotones.indexOf('<div')) + 1);
  const pass = /min-w-0/.test(aperturaBadge) && /min-w-0/.test(aperturaBotones) && /flex-wrap/.test(aperturaBotones);
  return { pass, actual: { badge: aperturaBadge, botones: aperturaBotones } };
});

check('el-punto-y-el-texto-del-badge-no-se-deforman', () => {
  // El puntito de color no puede encogerse (flex-shrink-0) y el texto sí
  // puede recortarse (truncate) — sin eso, el círculo se convierte en óvalo
  // antes de que el texto ceda un píxel.
  const zona = html.slice(html.indexOf('id="connection-badge-bottom"'), html.indexOf('id="connection-badge-bottom"') + 500);
  return { pass: /flex-shrink-0/.test(zona) && /truncate/.test(zona), actual: zona.slice(0, 320) };
});

run('layout invariants bench', CHECKS);
