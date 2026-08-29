/**
 * Shortcut consistency bench — v1.0.2.
 *
 * Existe porque el MISMO defecto apareció dos veces: un atajo global que se
 * registra en shortcuts.js, emite su evento, y el renderer no tiene ninguna
 * rama que lo maneje. Falla en silencio — el atajo simplemente "no hace nada",
 * que es imposible de distinguir de un conflicto de teclas con otra app de
 * Windows.
 *
 *   - Ctrl+Shift+R: registrado desde su primer commit, sin rama en
 *     handleShortcut(). Nunca funcionó hasta que se detectó en la Fase 9
 *     (v3.13.6x); hay un comentario en renderer.js contándolo.
 *   - Ctrl+Shift+O: exactamente lo mismo, encontrado por Lyca probando los
 *     atajos que habíamos documentado (v1.0.2).
 *
 * Que pase dos veces no es mala suerte: nada ata las dos listas. El main
 * decide qué acciones emite y el renderer decide cuáles entiende, en archivos
 * distintos, sin ningún punto de contacto que se rompa cuando divergen.
 *
 * Y un tercer eje de deriva, del mismo reporte: la lista de atajos que la app
 * le MUESTRA al usuario en index.html tenía 4 entradas mientras shortcuts.js
 * registraba 7 — la app mentía sobre sus propios atajos.
 *
 * Análisis estático puro sobre el texto de los tres archivos. Sin Electron,
 * sin DOM.
 *
 *   node scripts/test-shortcuts-consistency.js
 *   node scripts/test-shortcuts-consistency.js --quiet
 */
const fs = require('fs');
const path = require('path');

const { makeEagerCheckRegistry } = require('./lib/bench.js');
const { check, report } = makeEagerCheckRegistry();

const root = path.join(__dirname, '..');
const shortcutsSrc = fs.readFileSync(path.join(root, 'src', 'main', 'shortcuts.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(root, 'renderer', 'main', 'renderer.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(root, 'renderer', 'main', 'index.html'), 'utf8');

// ─── Extracción ────────────────────────────────────────────────────────────

/** Aceleradores registrados: globalShortcut.register('CommandOrControl+Shift+X') */
const registered = [...shortcutsSrc.matchAll(/globalShortcut\.register\(\s*'([^']+)'/g)]
  .map((m) => m[1].replace('CommandOrControl', 'Ctrl'));

/** Acciones que el main manda al renderer dentro del payload shortcut-pressed. */
const emittedActions = [...shortcutsSrc.matchAll(/action:\s*'([^']+)'/g)].map((m) => m[1]);

/** Acciones que el renderer sabe manejar: data.action === 'xxx' en handleShortcut(). */
const handlerBody = (() => {
  const start = rendererSrc.indexOf('function handleShortcut');
  if (start === -1) return '';
  // Corta en la próxima declaración de función de nivel superior; alcanza
  // porque handleShortcut() no anida funciones con esa indentación.
  const rest = rendererSrc.slice(start + 1);
  const end = rest.search(/\n        function /);
  return end === -1 ? rest : rest.slice(0, end);
})();
const handledActions = [...handlerBody.matchAll(/data\.action\s*===\s*'([^']+)'/g)].map((m) => m[1]);

/** Aceleradores que la app le muestra al usuario en la referencia de atajos. */
const shownInUi = (() => {
  const grid = htmlSrc.match(/id="shortcuts-grid"[\s\S]*?<\/div>\s*<\/div>/);
  if (!grid) return [];
  return [...grid[0].matchAll(/<kbd[^>]*>([^<]+)<\/kbd>/g)].map((m) => m[1].trim());
})();

/**
 * Atajos deliberadamente fuera de la referencia de la UI. Cualquier cosa acá
 * necesita un motivo escrito: la lista existe para que omitir un atajo sea una
 * decisión, no un olvido.
 */
const UI_EXEMPT = new Map([
  ['Ctrl+Shift+D', 'DevTools — herramienta de desarrollo, no le sirve al usuario final'],
]);

// ─── Checks ────────────────────────────────────────────────────────────────

check('every-emitted-action-is-handled', () => {
  const orphans = emittedActions.filter((a) => !handledActions.includes(a));
  return { pass: orphans.length === 0, actual: orphans };
}, 'El defecto que este archivo existe para atrapar: el main emite una acción que el renderer ignora, así que el atajo no hace nada y falla en silencio. Pasó con Ctrl+Shift+R y después con Ctrl+Shift+O.');

check('every-handled-action-is-emitted', () => {
  const dead = handledActions.filter((a) => !emittedActions.includes(a));
  return { pass: dead.length === 0, actual: dead };
}, 'La dirección inversa: una rama en handleShortcut() para una acción que ya nadie emite es código muerto que aparenta cobertura.');

check('registered-shortcuts-are-shown-in-ui', () => {
  const missing = registered.filter((k) => !shownInUi.includes(k) && !UI_EXEMPT.has(k));
  return { pass: missing.length === 0, actual: missing };
}, 'La app tiene que mostrar los atajos que realmente registra. Llegó a mostrar 4 de 7; el usuario no puede descubrir lo que no está listado.');

check('ui-shows-no-unregistered-shortcuts', () => {
  const phantom = shownInUi.filter((k) => !registered.includes(k));
  return { pass: phantom.length === 0, actual: phantom };
}, 'Peor que omitir uno: prometer un atajo que no existe. El README y el sitio llegaron a documentar Ctrl+Shift+T y Ctrl+Shift+C, que nunca se registraron.');

check('ui-shortcut-labels-are-translatable', () => {
  const grid = htmlSrc.match(/id="shortcuts-grid"[\s\S]*?<\/div>\s*<\/div>/);
  if (!grid) return { pass: false, actual: 'no se encontró #shortcuts-grid' };
  // Cada fila es <span>etiqueta</span><kbd>tecla</kbd>; el span necesita
  // data-i18n o queda clavado en un idioma.
  const rows = [...grid[0].matchAll(/<span([^>]*)>([^<]+)<\/span>\s*<kbd/g)];
  const untranslated = rows.filter(([, attrs]) => !attrs.includes('data-i18n')).map(([, , label]) => label.trim());
  return { pass: untranslated.length === 0, actual: untranslated };
}, 'Las 4 etiquetas originales estaban hardcodeadas en inglés y no seguían el idioma de la interfaz — reportado por Lyca.');

check('exempt-shortcuts-are-actually-registered', () => {
  const stale = [...UI_EXEMPT.keys()].filter((k) => !registered.includes(k));
  return { pass: stale.length === 0, actual: stale };
}, 'Si un atajo exento deja de registrarse, su excepción queda huérfana y silenciaría un atajo futuro que reusara esa tecla.');

report();
