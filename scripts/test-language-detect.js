/**
 * Detección de idioma origen — bench de v1.0.11.
 *
 * `detectLanguageSimple()` decide el idioma origen de TODA traducción con
 * auto-detect, en todos los motores, y hasta esta versión no tenía un solo
 * test — pese a ocho rondas de ajustes documentadas en sus propios
 * comentarios (v3.13.04 → v3.13.23). Este archivo la cubre; el bug del kanji
 * de ruido fue la excusa, no el único motivo.
 *
 * El bug: PaddleOCR lee el ícono de viñeta de un juego EN INGLÉS como el
 * kanji 其, y una letra CJK entre sesenta latinas alcanzaba para declarar la
 * línea japonesa. Google traducía inglés como si fuera japonés. El A/B está
 * en el log real, con la misma oración:
 *
 *   "其 You perform poorly when you can' tell…" → ja → "Que te desempeñas mal…"
 *   "You perform poorly when you can' tell…"    → en → "Tu desempeño es deficiente…"
 *
 * Se prueban LAS DOS funciones juntas porque el resultado que ve el usuario
 * sale de las dos: si la detección dice "no sé", `hasNonLatinScript()` es la
 * red que decide entre japonés e inglés. Arreglar una sola no cambiaba nada.
 *
 * La mitad "no romper el japonés" pesa MÁS que la mitad "arreglar el ruido":
 * mandar japonés de verdad a traducir como inglés rompería el uso principal
 * de la app.
 *
 *   node scripts/test-language-detect.js
 *   node scripts/test-language-detect.js --quiet
 */
const path = require('path');
const TranslationPipeline = require(path.join('..', 'src', 'services', 'translation', 'pipeline.js'));
const { detectLanguageSimple, hasNonLatinScript } = TranslationPipeline;

const { makeCheckRegistry, run } = require('./lib/bench.js');
const { check, CHECKS } = makeCheckRegistry();

/**
 * La decisión COMPLETA tal como la toma _doTranslate() con sourceLang='auto'
 * (pipeline.js, "1. Cache/TM/context key" arriba): detección primero, y si
 * no hay veredicto, japonés o inglés según haya o no escritura no latina.
 * Es lo que el usuario termina viendo, y ninguna de las dos funciones sola
 * lo determina.
 */
function idiomaEfectivo(text) {
  const detectado = detectLanguageSimple(text);
  if (detectado) return detectado;
  return hasNonLatinScript(text) ? 'ja' : 'en';
}

const eq = (actual, expected) => ({ pass: actual === expected, actual, expected });

// ─── El bug reportado ────────────────────────────────────────────────────
check('el-caso-reportado-un-kanji-de-ruido-no-vuelve-japones-al-ingles', () => {
  return eq(idiomaEfectivo("其 You perform poorly when you can' tell if you' re doing well or not."), 'en');
}, 'Textual del log 16:16:53. La misma oración sin el 其 ya daba en (16:17:29): el A/B está en el propio log del usuario.');

check('las-otras-basuras-que-produjo-el-mismo-OCR', () => {
  const casos = [
    '英 When something you cared about fails or ends, it takes you a long time',
    '自 其 You adjust the way you act and talk depending on who you are with.',
    '× You believe asking others for help equates to failing.',
    '# do you think that even the worst person can change'
  ];
  const malos = casos.filter((t) => idiomaEfectivo(t) !== 'en');
  return { pass: malos.length === 0, actual: malos.map((t) => `${t.slice(0, 30)} → ${idiomaEfectivo(t)}`) };
});

check('una-katakana-suelta-tampoco-alcanza', () => {
  // 15:58:59 del log. Esta entraba por la regla "tiene kana → japonés,
  // definitivo", que es anterior a la de kanji: por eso la guardia va antes
  // que todo lo demás y no dentro de la rama de sólo-kanji.
  return eq(idiomaEfectivo('其 You can tell when things are over. イ'), 'en');
});

check('una-cirilica-suelta-en-ingles-tampoco', () => {
  // Hermano del mismo defecto, sin reporte todavía: el OCR leyendo 'В' por
  // 'B'. detectLanguageSimple pedía 3+ cirílicas para decir ru, pero
  // hasNonLatinScript daba true con una y la línea caía en japonés igual.
  return eq(idiomaEfectivo('You Вelieve that the end justifies the means.'), 'en');
});

// ─── Lo que NO se puede romper: japonés de verdad ────────────────────────
check('japones-con-kana-sigue-siendo-japones', () => {
  const casos = ['「そんなことないよ」と彼女は言った。', 'こんにちは', 'ホテルに泊まる', 'HPが50減少した'];
  const malos = casos.filter((t) => idiomaEfectivo(t) !== 'ja');
  return { pass: malos.length === 0, actual: malos };
});

check('japones-solo-kanji-sigue-siendo-japones', () => {
  // v3.13.06/07: UI de juego y texto sin kana. La regla de ≤4 kanji y la
  // tabla de kanji japoneses específicos siguen mandando.
  const casos = ['設定', '移動', '終了', '桜', '図書館', '主人公', '魔王城'];
  const malos = casos.filter((t) => idiomaEfectivo(t) !== 'ja');
  return { pass: malos.length === 0, actual: malos };
});

check('una-barra-de-UI-bilingue-sigue-siendo-japonesa', () => {
  // 設定 son dos kanji PEGADOS: una palabra, no basura suelta. Éste es el
  // caso que hizo descartar el umbral de proporción a secas — "AUTO SKIP LOG
  // 設定" daba 0,154 contra un corte de 0,15, o sea que una letra más lo
  // volvía inglés. La regla de rachas lo resuelve sin depender del filo.
  const casos = ['SAVE 設定', 'AUTO SKIP LOG 設定', 'AUTO SKIP LOG BACKLOG CONFIG MENU 設定'];
  const malos = casos.filter((t) => idiomaEfectivo(t) !== 'ja');
  return { pass: malos.length === 0, actual: malos };
});

check('dos-caracteres-de-ruido-separados-no-forman-palabra', () => {
  // "自 其" del log (16:01:56): dos íconos mal leídos, no una palabra. Es el
  // caso que descartó tolerar el espacio dentro de una racha.
  return eq(idiomaEfectivo('自 其 You adjust the way you act and talk depending on who you are with.'), 'en');
});

check('mezcla-real-de-japones-e-ingles-sigue-siendo-japones', () => {
  // 20 latinas pero 12 caracteres japoneses: 37% de no latino, muy por
  // encima del 15%. Es texto genuinamente mezclado, no ruido de OCR.
  return eq(idiomaEfectivo('Game Over 続きからやり直しますか'), 'ja');
});

check('la-puntuacion-japonesa-sigue-decidiendo', () => {
  return eq(idiomaEfectivo('東京、大阪。'), 'ja');
});

// ─── Otros idiomas ───────────────────────────────────────────────────────
check('coreano-sigue-siendo-coreano', () => eq(idiomaEfectivo('주인공: 뭔가 이상해요.'), 'ko'));

check('ruso-sigue-siendo-ruso', () => eq(idiomaEfectivo('Привет, как дела?'), 'ru'));

check('ruso-mezclado-con-latin-sigue-siendo-ruso', () => {
  // 35% de cirílico: mezcla real, la guardia no se mete.
  return eq(idiomaEfectivo('Привет как estas amigo mio'), 'ru');
});

// ─── Texto latino puro y bordes ──────────────────────────────────────────
check('ingles-limpio-da-ingles', () => eq(idiomaEfectivo('You would rather be hated than pretend.'), 'en'));

check('vacio-y-basura-no-tiran', () => {
  const casos = [detectLanguageSimple(''), detectLanguageSimple(null), hasNonLatinScript(''), hasNonLatinScript(null)];
  return { pass: casos[0] === null && casos[1] === null && casos[2] === false && casos[3] === false, actual: casos };
});

check('simbolos-y-numeros-solos-no-son-japones', () => eq(idiomaEfectivo('!!! 123 ### ...'), 'en'));

run('language detection bench', CHECKS);
