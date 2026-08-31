/**
 * Dedup de texto del OCR — bench de v1.0.9.
 *
 * Lo reportado: "el OCR a veces no detecta el cambio de texto, tanto con
 * Tesseract como con PaddleOCR". No es que no lo lea: lo lee y lo descarta.
 * Log real del 2026-08-30, con el diálogo revelándose de a poco:
 *
 *   15:54:31  Recognized: "* You tend to avoid doing things that"
 *   15:54:48  Similar text skipped (100% similar to last): "…make you unc…"
 *   15:54:53  Similar text skipped (100% similar to last): …
 *   15:55:06  Similar text skipped (100% similar to last): …
 *   15:55:06  [Shortcuts] OCR capture hotkey triggered   ← forzado a mano
 *
 * La regla de prefijo de `_computeSimilarity` era ciega a la dirección: daba
 * 1.0 tanto para "releí la misma línea, peor y más corta" (descartar) como
 * para "la línea terminó de aparecer" (traducir).
 *
 * Corre los métodos REALES del servicio sobre `Object.create()` — el
 * constructor de OcrService arma workers y ventanas, y estos métodos no
 * necesitan nada de eso. La mitad "no romper el dedup" pesa tanto como la
 * mitad "detectar la continuación": sin ella, cada relectura ruidosa de la
 * misma línea se traduce de nuevo.
 *
 *   node scripts/test-ocr-dedup.js
 *   node scripts/test-ocr-dedup.js --quiet
 */
const path = require('path');
const OcrService = require(path.join('..', 'src', 'services', 'ocr.js'));

const { makeCheckRegistry, run } = require('./lib/bench.js');
const { check, CHECKS } = makeCheckRegistry();

/** Sólo el umbral: es lo único que estos tres métodos leen del objeto. */
function ocr() {
  const svc = Object.create(OcrService.prototype);
  svc._similarityThreshold = 0.80;
  return svc;
}

/** true = se descarta (no se traduce). */
const descarta = (nuevo, anterior) => ocr()._isSimilarText(nuevo, anterior);

// ─── El bug reportado ────────────────────────────────────────────────────
const PARCIAL = '* You tend to avoid doing things that';
const COMPLETA = '* You tend to avoid doing things that make you uncomfortable. 3';

check('el-bug-reportado-la-linea-completada-si-se-traduce', () => {
  return { pass: descarta(COMPLETA, PARCIAL) === false, actual: null };
}, 'Las dos cadenas son textuales del log: la parcial se tradujo 15:54:31 y la completa se descartó tres veces seguidas.');

check('la-continuacion-gana-aunque-la-similitud-de-palabras-sea-alta', () => {
  // Línea larga a la que completarse le suma poco: el Jaccard queda por
  // encima del umbral y el bug volvería por la otra puerta si la
  // continuación no ganara sobre CUALQUIER medida de similitud.
  const anterior = 'you have taken up many things that you have not seen through to the end and you regret most of them today';
  const nuevo = `${anterior} because you never really wanted them`;
  const ocrSvc = ocr();
  const jaccardAlto = ocrSvc._computeSimilarity(nuevo, anterior) >= 0.80;
  return { pass: jaccardAlto && descarta(nuevo, anterior) === false, actual: { similitud: ocrSvc._computeSimilarity(nuevo, anterior) } };
});

check('tres-revelados-seguidos-se-traducen-los-tres', () => {
  const a = 'do you think';
  const b = 'do you think that even the worst person';
  const c = 'do you think that even the worst person can change, that everybody can be good if they tried';
  return { pass: !descarta(b, a) && !descarta(c, b), actual: { b: descarta(b, a), c: descarta(c, b) } };
}, 'El efecto máquina de escribir no da un salto único: cada pausa del OCR es un estado intermedio más.');

// ─── No romper el dedup, que es para lo que la regla existía ─────────────
check('la-misma-linea-releida-mas-corta-se-sigue-descartando', () => {
  return { pass: descarta(PARCIAL, COMPLETA) === true, actual: null };
}, 'La dirección inversa es el caso ORIGINAL de la regla de prefijo: el OCR volvió a leer la misma línea y le faltó texto. Traducirla de nuevo sería un duplicado.');

check('una-relectura-con-ruido-al-final-se-sigue-descartando', () => {
  const limpia = '* You tend to avoid doing things that make you uncomfortable.';
  const conRuido = '* You tend to avoid doing things that make you uncomfortable. 3';
  return { pass: descarta(conRuido, limpia) === true, actual: null };
}, 'Es la misma línea con un caracter de basura pegado: crece 3%, muy por debajo del 20% que se exige. Sin este piso, cada parpadeo del OCR sería una traducción nueva.');

check('el-texto-identico-se-descarta', () => {
  return { pass: descarta(COMPLETA, COMPLETA) === true, actual: null };
});

check('la-misma-linea-sin-la-basura-del-principio-se-descarta', () => {
  // Log 16:17:28, "Similar text skipped (93% similar)": PaddleOCR dejó de
  // leer el ícono como 其. Es la misma línea, no una nueva.
  const conBasura = "其 You perform poorly when you can' tell if you' re doing well or not.";
  const limpia = "You perform poorly when you can' tell if you' re doing well or not.";
  return { pass: descarta(limpia, conBasura) === true, actual: null };
});

check('una-linea-distinta-si-se-traduce', () => {
  return { pass: descarta('You believe that the end justifies the means.', COMPLETA) === false, actual: null };
});

// ─── Bordes ──────────────────────────────────────────────────────────────
check('un-texto-que-empieza-igual-pero-sigue-distinto-no-es-continuacion', () => {
  // Comparte prefijo pero diverge: son dos líneas distintas del juego, no
  // una completándose. Que se traduzca está bien; lo que no puede es
  // contarse como "continuación", que es un concepto más fuerte.
  const anterior = 'you would rather be hated';
  const nuevo = 'you would rather be feared than respected by anyone at all';
  return { pass: ocr()._isContinuationOf(nuevo, anterior) === false, actual: null };
});

check('crecer-sin-conservar-el-principio-no-es-continuacion', () => {
  return { pass: ocr()._isContinuationOf('completely different and much longer text here', 'you tend to avoid') === false, actual: null };
});

check('los-vacios-y-nulos-no-tiran', () => {
  const o = ocr();
  const casos = [o._isContinuationOf('', 'algo'), o._isContinuationOf('algo', ''), o._isContinuationOf(null, undefined)];
  return { pass: casos.every((c) => c === false), actual: casos };
}, '_lastEmittedText arranca vacío: la primera captura de cada sesión pasa por acá.');

run('OCR dedup bench', CHECKS);
