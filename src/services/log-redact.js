/**
 * Redacción de secretos para el archivo de log — v1.0.7.
 *
 * El archivo de log de Tuhua existe para mandárselo a otra persona: el botón
 * "Logs" copia las últimas 100 líneas y el botón "Carpeta" abre el explorador
 * con `main.log` seleccionado, justamente para adjuntarlo a un reporte. Y por
 * ahí pasa todo lo que el usuario copia al portapapeles, porque el modo
 * Portapapeles loguea el texto entrante.
 *
 * Caso real (2026-08-30): el usuario copió su API key de Anthropic al
 * portapapeles con Tuhua abierto, y la key quedó escrita en `main.log`:
 *
 *   [Tuhua] _handleText: ... text="sk-ant-api03-uWnRhuqD0NVfL4fLaJ4X2N5-P4s..."
 *
 * Después mandó ese log para diagnosticar otra cosa. Nadie hizo nada mal: el
 * flujo que el producto recomienda para reportar un problema es, tal como
 * estaba, un flujo que filtra credenciales.
 *
 * Se engancha UNA vez en el transporte de archivo (src/main/index.js), no en
 * cada `console.log` — misma decisión que el puente console→archivo de v1.0.3:
 * un punto único no puede olvidarse de ninguna línea, ni de las que se
 * escriban mañana. La consola queda sin tocar a propósito: esa salida no se
 * comparte con nadie y es la que se usa para depurar con `pnpm dev`.
 *
 * NO se toca nunca el texto que se manda a los motores de traducción: acá se
 * redacta lo que se ESCRIBE AL ARCHIVO, nada más.
 */

/**
 * Prefijos de credenciales de proveedores reales. Se conserva el prefijo
 * (dice qué era, y eso es lo diagnosticable) y se borra el resto.
 * El orden importa: alternativas más largas primero, porque la alternancia
 * de una regex toma la primera que encaja ('sk-ant-api03-' tiene que ganarle
 * a 'sk-').
 */
const PREFIXED_SECRET = /\b(sk-ant-api\d{2}-|sk-ant-|sk-proj-|sk-svcacct-|sk-or-v1-|sk-|gsk_|hf_|github_pat_|ghp_|gho_|ghs_|glpat-|xox[baprs]-|AIza|ya29\.|dop_v1_|nvapi-)[A-Za-z0-9_\-]{8,}/g;

/** DeepL Free: UUID terminado en ':fx'. */
const DEEPL_KEY = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:fx\b/gi;

/** Encabezado Authorization, por si alguna vez se loguea un request entero. */
const BEARER = /\b(Bearer\s+)[A-Za-z0-9_\-.=]{8,}/gi;

/** `apiKey: valor`, `token=valor`, `password: valor`. Se conserva la etiqueta. */
const LABELLED_SECRET = /\b(api[_-]?key|apikey|access[_-]?token|token|secret|password|contrase(?:ñ|n)a)("?\s*[:=]\s*"?)([^\s",;}]{6,})/gi;

/**
 * Red de seguridad para credenciales cuyo prefijo no conocemos (o que
 * llegaron ya cortadas por un `substring()` de otro log): cualquier corrida
 * opaca de 40+ caracteres.
 *
 * A diferencia de las reglas de arriba, ésta SÍ deja ver los primeros 6
 * caracteres y el largo. Es a propósito: la misma regla toca cosas que no son
 * secretos y que sirven para diagnosticar —el sha512 en base64 que compara el
 * auto-updater, por ejemplo—, y dos hashes distintos tienen que seguir
 * viéndose distintos en el log. Seis caracteres alcanzan para eso y no
 * alcanzan para usar una credencial.
 */
const LONG_OPAQUE_RUN = /\b[A-Za-z0-9_\-]{40,}\b/g;

/**
 * @param {string} str
 * @returns {string} el mismo texto con las credenciales tapadas
 */
function redactSecrets(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    .replace(PREFIXED_SECRET, (_m, prefix) => `${prefix}[REDACTADO]`)
    .replace(DEEPL_KEY, '[REDACTADO]:fx')
    .replace(BEARER, (_m, prefix) => `${prefix}[REDACTADO]`)
    .replace(LABELLED_SECRET, (_m, label, sep) => `${label}${sep}[REDACTADO]`)
    .replace(LONG_OPAQUE_RUN, (run) => `${run.slice(0, 6)}…[REDACTADO:${run.length}]`);
}

/**
 * Transform de electron-log para `transports.file.transforms`. Va ÚLTIMO en
 * el arreglo: para entonces los transforms propios de la librería ya
 * convirtieron todo a texto, así que basta con mirar strings.
 * Nunca tira: el logging es diagnóstico, no funcionalidad.
 */
function redactFileTransform({ data }) {
  try {
    if (typeof data === 'string') return redactSecrets(data);
    if (Array.isArray(data)) {
      return data.map((item) => (typeof item === 'string' ? redactSecrets(item) : item));
    }
    return data;
  } catch (e) {
    return data;
  }
}

module.exports = { redactSecrets, redactFileTransform };
