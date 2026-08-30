/**
 * Correr funciones REALES de renderer.js en un banco — v1.0.7.
 *
 * `renderer/main/renderer.js` es código de navegador sin exports: se carga
 * dentro de una ventana de Electron y todas sus funciones son globales del
 * script. Eso dejaba dos opciones malas —no probarlo, o probar una copia de
 * la lógica que puede pasar mientras la que se envía está rota— y una buena:
 * sacar la función real del archivo por nombre y correrla contra un DOM
 * falso mínimo.
 *
 * Extraído de test-toast-notices.js (v1.0.6) al aparecer el segundo
 * consumidor (test-model-suggestions.js), mismo criterio que lib/bench.js:
 * se extrae cuando la duplicación es real, no antes.
 *
 * El DOM falso implementa SÓLO lo que estas funciones tocan. Si una función
 * nueva necesita algo más, agregarlo acá con una prueba que lo ejercite —
 * nunca stubbear de más "por las dudas": cada método de mentira es una
 * chance de que el banco pase donde el navegador fallaría.
 */

/**
 * Corta un `function nombre(...) { … }` de nivel superior contando llaves.
 * Alcanza porque en las funciones que se extraen las llaves están
 * balanceadas también dentro de strings y template literals; si alguna vez
 * eso deja de ser cierto, este helper tira en vez de devolver algo cortado.
 */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name}() no está en renderer.js`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`llaves desbalanceadas leyendo ${name}()`);
}

class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this.style = {};
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.placeholder = '';
    this.id = '';
    this.children = [];
    this.parentNode = null;
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  prepend(c) { c.parentNode = this; this.children.unshift(c); return c; }
  setAttribute() {}
  hasChildNodes() { return this.children.length > 0; }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  querySelector(sel) {
    const cls = sel.replace(/^\./, '');
    for (const c of this.children) {
      if (String(c.className).split(/\s+/).includes(cls)) return c;
      const deep = c.querySelector(sel);
      if (deep) return deep;
    }
    return null;
  }
  findById(id) {
    for (const c of this.children) {
      if (c.id === id) return c;
      const deep = c.findById(id);
      if (deep) return deep;
    }
    return null;
  }
}

/** Documento falso con un `body` vacío. */
function makeDocument() {
  const body = new FakeEl('body');
  return {
    body,
    createElement: (tag) => new FakeEl(tag),
    getElementById: (id) => body.findById(id)
  };
}

module.exports = { extractFunction, FakeEl, makeDocument };
