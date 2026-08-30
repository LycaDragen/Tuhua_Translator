# Changelog

## [1.0.4] — los servidores LLM locales preconfigurados no funcionaban

### Arreglado

- **Elegir Ollama (o LM Studio, llama.cpp o KoboldCpp) dejaba la dirección en `undefined`.** El
  proceso principal enviaba la lista de servidores al panel de configuración **sin la dirección
  de cada uno**, así que el campo se rellenaba con la palabra literal `undefined` y el botón
  Validar respondía `Error 0: Invalid URL`. Afectaba a los cuatro servidores por igual.
  La traducción en sí seguía funcionando —la dirección real se resolvía por otro camino, del lado
  del proceso principal— pero no había forma de comprobarlo desde la interfaz.

### Cambiado

- El campo de dirección ahora aclara debajo **"Dirección de Ollama (:11434), configurada
  automáticamente"** cuando hay un servidor elegido. Antes el campo quedaba bloqueado y en gris
  sin explicación, y se leía como "no puedo escribir acá" en vez de "esto ya está resuelto".
- El texto de ejemplo del campo, para el modo Personalizado, sugería el puerto de LM Studio sin
  importar qué servidor tuvieras elegido.

## [1.0.3] — logs útiles para reportar problemas

### Arreglado

- **Más de la mitad del diagnóstico no llegaba al archivo de log.** El código usa dos sistemas en
  paralelo: uno escribe a disco y el otro sólo a la terminal — que un usuario final no tiene. Y
  estaban repartidos justo al revés de lo conveniente: el módulo de Textractor tenía 63 líneas
  invisibles contra 1 guardada. Un reporte de "Textractor no engancha" llegaba, literalmente, sin
  una sola línea sobre Textractor. Ahora todo queda en el archivo.

### Nuevo

- **Botón "Carpeta"** junto al de Logs: abre el explorador con el archivo de log ya seleccionado,
  para adjuntarlo a un reporte. El botón Logs sigue copiando las últimas 100 líneas al
  portapapeles, que sirve para un vistazo rápido pero se queda corto en un problema real.
- La [documentación](https://tuhua.lyca.dev/referencia/reportar-bug/) ahora incluye la ruta del
  archivo en cada sistema operativo.

### Cambiado

- El log rota a los 5 MB en vez de 1 MB. Con todo el diagnóstico yendo al archivo, 1 MB se llenaba
  en pocas sesiones y la rotación se llevaba justo el arranque, que es donde está el contexto de
  qué motor y qué método estaban activos.

## [1.0.2] — arreglos de atajos

### Arreglado

- **`Ctrl+Shift+O` no hacía nada.** El atajo estaba registrado y emitía su evento, pero el
  renderer nunca tuvo una rama para manejarlo, así que ciclar la opacidad del overlay jamás
  funcionó. Ahora sí: la opacidad cicla entre 100/85/70/55/40 y el slider de Configuración se
  mueve con ella. (Mismo defecto que le pasó antes a `Ctrl+Shift+R`.)

### Cambiado

- **Las listas de atajos ahora coinciden.** La Guía de Inicio de la app mostraba 4 atajos, el
  código registraba 7 y la documentación mostraba otra cosa. Las tres muestran los mismos 6
  atajos de usuario; `Ctrl+Shift+D` (DevTools) queda fuera por ser de desarrollo.
- Se aclaró qué hace `Ctrl+Shift+R` frente a `Ctrl+Shift+S`: el primero vuelve a traducir el
  texto que ya está en pantalla, el segundo toma una captura de OCR nueva (y sólo aplica en modo
  OCR). Se veían iguales al probarlos si la pantalla no había cambiado.
- El atajo de opacidad ya no muestra un aviso en pantalla: el overlay cambiando de opacidad es
  el feedback, y los avisos se apilaban al ciclar varias veces.

### Interno

- Nuevo bench `test:shortcuts-consistency`. El defecto de `Ctrl+Shift+O` era el mismo que ya
  había pasado con `Ctrl+Shift+R`: un atajo que se registra, emite su evento y no tiene quién lo
  maneje falla en silencio, indistinguible de un conflicto de teclas. El bench ata las tres
  listas que antes derivaban por separado — lo que el main emite, lo que el renderer maneja, y lo
  que la app le muestra al usuario — y verifica además que las etiquetas sean traducibles.

## [1.0.1] — buscador de actualizaciones

### Nuevo

- **Aviso de versión nueva.** Tuhua consulta GitHub 30 segundos después de abrir (o cuando
  apretás **Configuración → Avanzado → Buscar actualizaciones**) y, si hay una versión más
  nueva, muestra un aviso. Nada se descarga ni se instala sin que hagas clic: se puede
  descargar, ver los cambios, o ignorar esa versión concreta — si ignorás la 1.0.2 y sale la
  1.0.3, te vuelve a avisar.
- En **Windows y Linux** la actualización se descarga e instala desde la propia app. En
  **macOS** sólo avisa y abre la página de descarga: Apple exige una firma de código de pago
  para permitir auto-actualización, y Tuhua no la tiene.
- El chequeo automático se puede apagar en Configuración → Avanzado.

### Arreglado

- **Los instaladores de `v3.13.120` no abrían** (`Cannot find module 'conf'`). El empaquetador
  no incluía las dependencias transitivas por cómo pnpm arma `node_modules`; se corrigió con
  `nodeLinker: hoisted`. Los assets de ese release ya fueron reemplazados por versiones
  funcionales.

### Nota para quien venga de la 3.13.x

Si instalaste Tuhua antes de este release y tu versión aparece como `3.13.120`, el buscador de
actualizaciones **no** te va a ofrecer la 1.0.1, porque `1.0.1` es un número menor que
`3.13.120` (ver la entrada de 1.0.0 sobre el reinicio del versionado). Hay que reinstalar a
mano una vez desde [Releases](https://github.com/LycaDragen/Tuhua_Translator/releases); a
partir de ahí las actualizaciones funcionan solas.

## [1.0.0] — reinicio del esquema de versionado

A partir de esta versión, Tuhua Translator usa [Semantic Versioning](https://semver.org/lang/es/)
real: `patch` para arreglos, `minor` para funcionalidades nuevas, `major` sólo si rompe
compatibilidad de perfiles o configuración guardada.

Los números `3.9.x`–`3.13.122` que preceden a este release fueron iteración interna de
desarrollo — nunca correspondieron a una versión pública equivalente (no seguían semver, eran
un contador de build incrementado en cada sesión de trabajo). El primer release público real
del proyecto, con instaladores para Windows/Linux/macOS, se publicó bajo el tag
[`v3.13.120`](https://github.com/LycaDragen/Tuhua_Translator/releases/tag/v3.13.120); esta
entrada de `1.0.0` marca el reinicio formal del esquema de versionado a partir de acá, no
necesariamente un release nuevo por sí solo.
