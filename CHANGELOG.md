# Changelog

## [1.0.2] — arreglos de atajos

### Arreglado

- **`Ctrl+Shift+O` no hacía nada.** El atajo estaba registrado y emitía su evento, pero el
  renderer nunca tuvo una rama para manejarlo, así que ciclar la opacidad del overlay jamás
  funcionó. Ahora sí, y muestra la opacidad resultante en un aviso. (Mismo defecto que le pasó
  antes a `Ctrl+Shift+R`.)

### Cambiado

- **Las listas de atajos ahora coinciden.** La Guía de Inicio de la app mostraba 4 atajos, el
  código registraba 7 y la documentación mostraba otra cosa. Las tres muestran los mismos 6
  atajos de usuario; `Ctrl+Shift+D` (DevTools) queda fuera por ser de desarrollo.
- Se aclaró qué hace `Ctrl+Shift+R` frente a `Ctrl+Shift+S`: el primero vuelve a traducir el
  texto que ya está en pantalla, el segundo toma una captura de OCR nueva (y sólo aplica en modo
  OCR). Se veían iguales al probarlos si la pantalla no había cambiado.

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
