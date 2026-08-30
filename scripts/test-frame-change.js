/**
 * Detección de cambio entre cuadros del OCR automático — bench de v1.0.10.
 *
 * Ésta era la causa real de "el OCR a veces no detecta el cambio de texto".
 * El detector viejo miraba 200 BYTES sueltos a paso fijo y exigía que 10
 * difirieran: en un área de captura típica, 200 píxeles de ~90.000 (0,2% de
 * la imagen, siempre los mismos). Como el texto son trazos finos sobre fondo
 * casi uniforme, la cantidad esperada de muestras alteradas caía justo en el
 * umbral — cara o cruz. Y descartar un cuadro es la decisión más silenciosa
 * del pipeline: el bucle recibe null y sigue sin loguear nada.
 *
 * Los cuadros de acá son mapas BGRA sintéticos con la forma de un cuadro de
 * diálogo real: fondo casi uniforme y renglones de "texto" ocupando una
 * fracción chica de los píxeles, que es lo que hace difícil el problema.
 *
 *   node scripts/test-frame-change.js
 *   node scripts/test-frame-change.js --quiet
 */
const path = require('path');
const IpcHandlers = require(path.join('..', 'src', 'main', 'ipc-handlers.js'));

const { makeCheckRegistry, run } = require('./lib/bench.js');
const { check, CHECKS } = makeCheckRegistry();

const W = 600;
const H = 150;
const detector = Object.create(IpcHandlers.prototype);
const cambio = (a, b) => detector._bitmapHasSignificantChange(a, b);

/** Fondo del cuadro de diálogo: gris oscuro casi uniforme. */
function fondo() {
  const buf = Buffer.alloc(W * H * 4);
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    buf[i] = 24; buf[i + 1] = 24; buf[i + 2] = 24; buf[i + 3] = 255;
  }
  return buf;
}

/**
 * "Escribe" un renglón: píxeles claros esparcidos en una franja horizontal,
 * cubriendo `densidad` de esa franja (los trazos de una tipografía cubren
 * alrededor del 20% del rectángulo que ocupan).
 * @param {Buffer} buf
 * @param {number} fila — píxel Y donde arranca el renglón
 * @param {number} desdeX, hastaX — extensión horizontal del renglón
 */
function escribirRenglon(buf, fila, desdeX, hastaX, densidad = 0.2, semilla = 1) {
  const alto = 20;
  let rnd = semilla;
  for (let y = fila; y < fila + alto && y < H; y++) {
    for (let x = desdeX; x < hastaX && x < W; x++) {
      rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
      if ((rnd / 0x7fffffff) < densidad) {
        const i = (y * W + x) * 4;
        buf[i] = 230; buf[i + 1] = 230; buf[i + 2] = 230; buf[i + 3] = 255;
      }
    }
  }
  return buf;
}

/**
 * El muestreo VIEJO, reproducido acá tal cual era. No es código de
 * producción y no se usa en ningún lado: está para que "el detector anterior
 * no veía esto" sea una afirmación ejecutable y no una anécdota del commit.
 */
function detectorViejo(oldBitmap, newBitmap) {
  const oldLen = oldBitmap.length;
  const newLen = newBitmap.length;
  if (Math.abs(oldLen - newLen) > oldLen * 0.05) return true;
  const sampleCount = 200;
  let changedPixels = 0;
  const step = Math.max(1, Math.floor(Math.min(oldLen, newLen) / sampleCount));
  for (let i = 0; i < Math.min(oldLen, newLen); i += step) {
    if (oldBitmap[i] !== newBitmap[i]) changedPixels++;
  }
  return ((changedPixels / sampleCount) * 100) >= 5;
}

// ─── El caso reportado ───────────────────────────────────────────────────
check('el-caso-reportado-completar-la-cola-de-un-renglon-se-detecta', () => {
  // 18:21:56 del log: "…that make you unconfor" quedó cortado y la versión
  // completa nunca volvió a capturarse. Entre los dos cuadros cambia sólo
  // el final de un renglón.
  const parcial = escribirRenglon(fondo(), 60, 20, 380);
  const completo = escribirRenglon(escribirRenglon(fondo(), 60, 20, 380), 60, 380, 560, 0.2, 99);
  return { pass: cambio(parcial, completo) === true, actual: null };
});

check('y-el-detector-viejo-no-lo-veia', () => {
  const parcial = escribirRenglon(fondo(), 60, 20, 380);
  const completo = escribirRenglon(escribirRenglon(fondo(), 60, 20, 380), 60, 380, 560, 0.2, 99);
  return { pass: detectorViejo(parcial, completo) === false, actual: null };
}, 'Si algún día esto empieza a fallar es una buena noticia: significa que el caso dejó de ser difícil. Sirve para no volver a "arreglar" el detector aflojándolo hasta acá.');

check('cambiar-la-frase-entera-se-detecta', () => {
  const a = escribirRenglon(fondo(), 60, 20, 560, 0.2, 7);
  const b = escribirRenglon(fondo(), 60, 20, 540, 0.2, 4242);
  return { pass: cambio(a, b) === true, actual: null };
});

check('dos-renglones-donde-cambia-solo-el-segundo', () => {
  const base = escribirRenglon(fondo(), 40, 20, 560, 0.2, 3);
  const a = escribirRenglon(Buffer.from(base), 80, 20, 400, 0.2, 11);
  const b = escribirRenglon(Buffer.from(base), 80, 20, 400, 0.2, 555);
  return { pass: cambio(a, b) === true, actual: null };
});

// ─── No dispararse al pedo ───────────────────────────────────────────────
check('el-mismo-cuadro-no-es-cambio', () => {
  const a = escribirRenglon(fondo(), 60, 20, 560);
  return { pass: cambio(a, Buffer.from(a)) === false, actual: null };
});

check('el-ruido-de-compresion-no-es-cambio', () => {
  // ±6 de luminancia en TODOS los píxeles: es exactamente lo que produce el
  // antialiasing y el reescalado, y no significa que el texto haya cambiado.
  const a = escribirRenglon(fondo(), 60, 20, 560);
  const b = Buffer.from(a);
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    const delta = (p % 2 === 0) ? 6 : -6;
    b[i] = Math.max(0, Math.min(255, b[i] + delta));
    b[i + 1] = Math.max(0, Math.min(255, b[i + 1] + delta));
    b[i + 2] = Math.max(0, Math.min(255, b[i + 2] + delta));
  }
  return { pass: cambio(a, b) === false, actual: null };
}, 'Sin tolerancia de luminancia, cada cuadro sería "nuevo" y el OCR correría siempre, que es el error opuesto.');

check('un-cursor-parpadeando-no-es-cambio', () => {
  // Un rectangulito de 8x20 px que aparece y desaparece: 0,18% de la imagen,
  // por debajo del medio punto que se exige.
  const a = escribirRenglon(fondo(), 60, 20, 560);
  const b = Buffer.from(a);
  for (let y = 60; y < 80; y++) {
    for (let x = 566; x < 574; x++) {
      const i = (y * W + x) * 4;
      b[i] = 230; b[i + 1] = 230; b[i + 2] = 230;
    }
  }
  return { pass: cambio(a, b) === false, actual: null };
});

// ─── Bordes ──────────────────────────────────────────────────────────────
check('un-recorte-de-otro-tamano-es-cambio', () => {
  const a = fondo();
  const b = Buffer.alloc(Math.floor(a.length * 0.5));
  return { pass: cambio(a, b) === true, actual: null };
}, 'El usuario movió o redimensionó el área de captura: no hay nada que comparar, hay que leer.');

check('un-buffer-vacio-no-tira-y-decide-leer', () => {
  const casos = [cambio(Buffer.alloc(0), Buffer.alloc(0)), cambio(Buffer.alloc(4), Buffer.alloc(4))];
  return { pass: casos[0] === true && typeof casos[1] === 'boolean', actual: casos };
}, 'Ante la duda, leer: perder una línea es peor que gastar una pasada de OCR.');

check('una-imagen-mas-chica-que-el-muestreo-igual-se-compara', () => {
  // 30x10 px = 300 píxeles, menos que las 4.000 muestras que se piden: el
  // paso tiene que caer a 1 y mirarlos todos, no dividir por cero.
  const chicoA = Buffer.alloc(30 * 10 * 4, 24);
  const chicoB = Buffer.from(chicoA);
  for (let p = 0; p < 40; p++) { const i = p * 4; chicoB[i] = 230; chicoB[i + 1] = 230; chicoB[i + 2] = 230; }
  return { pass: cambio(chicoA, Buffer.from(chicoA)) === false && cambio(chicoA, chicoB) === true, actual: null };
});

run('OCR frame-change bench', CHECKS);
