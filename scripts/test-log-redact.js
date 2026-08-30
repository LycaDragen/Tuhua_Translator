/**
 * log-redact.js bench — v1.0.7.
 *
 * El caso real (2026-08-30): un usuario copió su API key de Anthropic al
 * portapapeles con Tuhua abierto y la key quedó escrita en `main.log`, que es
 * justamente el archivo que el producto le pide mandar para reportar
 * problemas. Después lo mandó.
 *
 * Estas comprobaciones cubren las dos mitades del contrato, y la segunda
 * importa tanto como la primera: **tapar la credencial** y **no arruinar el
 * log**. Un redactor demasiado entusiasta rompe lo que la ronda v1.0.3
 * ("logs útiles para reportar problemas") vino a arreglar.
 *
 *   node scripts/test-log-redact.js
 *   node scripts/test-log-redact.js --quiet
 */
const path = require('path');
const { redactSecrets, redactFileTransform } = require(path.join('..', 'src', 'services', 'log-redact.js'));

const { makeCheckRegistry, run } = require('./lib/bench.js');
const { check, CHECKS } = makeCheckRegistry();

/** La key real del log, ya expirada, cortada como la cortó `substring(0, 60)`. */
const KEY_DEL_LOG = 'sk-ant-api03-uWnRhuqD0NVfL4fLaJ4X2N5-P4s1yk6grvOFsTX3ZyfyxBq';

const noContiene = (salida, secreto) => !salida.includes(secreto);

// ─── Tapar ───────────────────────────────────────────────────────────────
check('el-caso-reportado-la-linea-exacta-del-log', () => {
  const linea = `[Tuhua] _handleText: srcLang=en, tgtLang=es, engine=local-llm, active=false, inputMethod=clipboard, text="${KEY_DEL_LOG}..."`;
  const out = redactSecrets(linea);
  const pass = noContiene(out, 'uWnRhuqD0NVfL4fLaJ4X2N5') && out.includes('sk-ant-api03-[REDACTADO]') && out.includes('inputMethod=clipboard');
  return { pass, actual: out };
}, 'Log 2026-08-30 04:13:31, textual. El resto de la línea (que es el diagnóstico) tiene que sobrevivir intacto.');

check('tapa-las-claves-de-los-proveedores-que-tuhua-soporta', () => {
  const casos = [
    ['sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'sk-ant-api03-'],
    ['sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123', 'sk-proj-'],
    ['sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'sk-'],
    ['sk-or-v1-AbCdEfGhIjKlMnOpQrStUvWx0123456789', 'sk-or-v1-'],
    ['gsk_AbCdEfGhIjKlMnOpQrStUvWxYz0123', 'gsk_'],
    ['AIzaSyD-AbCdEfGhIjKlMnOpQrStUvWxYz01', 'AIza'],
    ['ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123', 'ghp_'],
    ['hf_AbCdEfGhIjKlMnOpQrStUvWxYz0123', 'hf_']
  ];
  const fallos = casos.filter(([raw, prefijo]) => {
    const out = redactSecrets(`clave ${raw} fin`);
    return !out.includes(`${prefijo}[REDACTADO]`) || out.includes(raw);
  });
  return { pass: fallos.length === 0, actual: fallos.map(([r]) => `${r} → ${redactSecrets(r)}`) };
}, 'Se conserva el prefijo a propósito: dice QUÉ credencial era, que es lo diagnosticable, sin dejar nada usable.');

check('tapa-la-key-de-deepl-free', () => {
  const out = redactSecrets('DEEPL_API_KEY=12345678-90ab-cdef-1234-567890abcdef:fx');
  return { pass: noContiene(out, '567890abcdef') && out.includes(':fx'), actual: out };
}, 'DeepL Free no tiene prefijo — se reconoce por la forma (UUID + :fx). El :fx queda para saber que era una key Free.');

check('tapa-un-bearer-y-un-valor-etiquetado', () => {
  const a = redactSecrets('headers: { Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdef }');
  const b = redactSecrets('apiKey: "MiClaveSuperSecreta123"');
  const pass = a.includes('Bearer [REDACTADO]') && noContiene(a, 'eyJhbGciOiJIUzI1NiJ9') &&
               b.includes('apiKey') && noContiene(b, 'MiClaveSuperSecreta123');
  return { pass, actual: { a, b } };
});

check('la-red-de-seguridad-tapa-una-credencial-sin-prefijo-conocido', () => {
  const raw = 'Xk92bPq7RtY3wLm5ZnQ8vHc1JdFs4GaT6UeI0oKrBy';  // 42 chars, sin prefijo
  const out = redactSecrets(`token entrante ${raw}`);
  return { pass: noContiene(out, raw) && out.includes('[REDACTADO:42]'), actual: out };
}, 'Cubre proveedores que Tuhua no conoce y claves que llegaron ya cortadas por el substring de otro log.');

check('la-redaccion-sobrevive-a-un-texto-con-varias-claves', () => {
  const out = redactSecrets(`una ${KEY_DEL_LOG} y otra sk-proj-AbCdEfGhIjKlMnOpQrSt0123`);
  return { pass: noContiene(out, 'uWnRhuqD') && noContiene(out, 'AbCdEfGhIjKlMnOpQrSt'), actual: out };
});

// ─── NO arruinar el log ──────────────────────────────────────────────────
check('el-dialogo-de-un-juego-pasa-intacto', () => {
  const lineas = [
    'Valessa: Yeah, something else is going on here. He\'s been acting strange.',
    'Ulric: Join the club. It\'s not like we anticipated this.',
    '「そんなことないよ」と彼女は言った。',
    '주인공: 뭔가 이상해요.',
    '"I don\'t know what\'s going on right now." Tom & Jerry <fin>'
  ];
  const cambiadas = lineas.filter((l) => redactSecrets(l) !== l);
  return { pass: cambiadas.length === 0, actual: cambiadas };
}, 'Traducir es lo que hace la app: si el redactor toca el diálogo, rompe el log para todo lo demás.');

check('las-lineas-de-diagnostico-normales-pasan-intactas', () => {
  const lineas = [
    '[Pipeline] openai engine built — preset=custom, fewShot=true, promptTemplateHash=27f8bb73, providerId=anthropic, model=claude-haiku-4-5, temperature=0.3, topP=null, maxTokens=1500',
    '[Pipeline] openai failed (HTTP 401): Invalid Anthropic API Key',
    '[Tuhua] Regex filter: 1/7 changed the text, 0 skipped — "hola" → "hola"',
    '[PaddleOCR] zh (file) dictionary loaded (18385 chars, blank+space convention, matches model\'s 18385 classes)',
    'Found version 1.0.6 (url: tuhua-translator-1.0.6-linux-x86_64.AppImage)',
    'https://github.com/LycaDragen/Tuhua_Translator/releases/download/v1.0.6/tuhua-translator-1.0.6-win-x64.exe'
  ];
  const cambiadas = lineas.filter((l) => redactSecrets(l) !== l);
  return { pass: cambiadas.length === 0, actual: cambiadas };
}, 'Líneas reales de los logs de esta misma semana. Una URL de release o un nombre de archivo largo NO son credenciales.');

check('un-hash-largo-sigue-siendo-comparable-aunque-se-tape', () => {
  const a = 'NACafpTWEQ62nQTzulmZ9x5WnyyBD2cqQU3c6FP8sxUUor1qFPoG56Tnqwx';
  const b = 'OyhE4F5bZWLMP7sCTOzEBihbjRTGA2m2InrjUx1qkFZPmPnCIqJCjUsw577';
  const ra = redactSecrets(a);
  const rb = redactSecrets(b);
  return { pass: ra !== rb && ra.startsWith('NACafp') && rb.startsWith('OyhE4F'), actual: { ra, rb } };
}, 'El updater compara dos sha512 en el log ("Cached: … expected: …"). Si la red de seguridad los volviera idénticos, esa línea dejaría de servir — por eso deja ver 6 caracteres y el largo.');

check('un-id-de-modelo-o-un-hash-corto-no-se-tocan', () => {
  const lineas = ['claude-haiku-4-5', 'promptTemplateHash=2d4f32ba', 'granite-4.0-h-tiny', 'deepseek-reasoner'];
  const cambiadas = lineas.filter((l) => redactSecrets(l) !== l);
  return { pass: cambiadas.length === 0, actual: cambiadas };
});

// ─── El transform de electron-log ────────────────────────────────────────
check('el-transform-redacta-cada-string-del-arreglo', () => {
  const out = redactFileTransform({ data: ['[Tuhua] text:', KEY_DEL_LOG, 42, null] });
  return { pass: Array.isArray(out) && noContiene(out[1], 'uWnRhuqD') && out[2] === 42 && out[3] === null, actual: out };
}, 'electron-log pasa `data` como arreglo: los no-strings (números, objetos ya serializados) tienen que salir tal cual.');

check('el-transform-acepta-un-string-suelto', () => {
  const out = redactFileTransform({ data: `key=${KEY_DEL_LOG}` });
  return { pass: typeof out === 'string' && noContiene(out, 'uWnRhuqD'), actual: out };
}, 'Depende de qué devuelva el último transform de la librería (`toString`) — se soportan las dos formas en vez de asumir una.');

check('el-transform-nunca-tira', () => {
  const raros = [{ data: undefined }, { data: null }, { data: 42 }, { data: { a: 1 } }, {}];
  let threw = null;
  for (const r of raros) {
    try { redactFileTransform(r); } catch (e) { threw = e.message; }
  }
  return { pass: threw === null, actual: threw };
}, 'El logging es diagnóstico, no funcionalidad: una excepción acá tumbaría la app entera por una línea de log.');

check('el-transform-esta-enganchado-en-LOS-DOS-transportes-de-archivo', () => {
  // El redactor perfecto no sirve de nada si nadie lo llama. Y son dos
  // enganches, no uno: `log` y el `_fileBridge` de v1.0.3 son instancias
  // distintas de electron-log escribiendo al MISMO archivo, y el puente es
  // justo por donde pasan los ~239 console.* — incluido el texto del
  // portapapeles. Enganchar sólo uno deja la fuga abierta por el lado que
  // más importa.
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf-8');
  const principal = /log\.transports\.file\.transforms\.push\(redactFileTransform\)/.test(src);
  const puente = /_fileBridge\.transports\.file\.transforms\.push\(redactFileTransform\)/.test(src);
  return { pass: principal && puente, actual: { logPrincipal: principal, puenteConsole: puente } };
});

check('la-consola-queda-sin-redactar-a-proposito', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf-8');
  return { pass: !/transports\.console\.transforms\.push/.test(src), actual: null };
}, 'La salida de consola no se comparte con nadie y es la que se usa para depurar con `pnpm dev` — redactarla ahí sería perder información sin ganar nada.');

run('log-redact.js bench', CHECKS);
