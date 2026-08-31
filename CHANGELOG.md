# Changelog

## [1.0.12] — el OCR mide el cambio por zonas, no sobre todo el recuadro

La v1.0.10 mejoró mucho la detección de texto nuevo, pero seguía perdiendo casos. Éste es el
motivo, encontrado en un log donde el bucle **estaba vivo** y aun así pasó trece segundos
decidiendo "no cambió nada" sobre texto que sí había cambiado.

### Arreglado

- **Un renglón que cambia dentro de un área de captura grande podía pasar desapercibido.** El
  cambio se medía sobre **todo el recorte**: si el área que elegiste es bastante más grande que el
  renglón de diálogo, cambiar una frase entera mueve un porcentaje minúsculo del total y quedaba
  por debajo del umbral. Ahora la imagen se divide en zonas y alcanza con que **una** cambie, así
  que la detección ya no depende de cuánto espacio vacío rodea al texto.

  Efecto secundario aceptado a propósito: un cursor parpadeando o una animación chica ahora
  disparan una pasada de OCR. Es barato —el texto repetido se descarta después— y es preferible a
  perder líneas en silencio.

### Cambiado

- **El log registra cada captura descartada, con los números medidos.** Antes se resumía por
  rachas para no llenar el archivo, y eso dejó una ventana de trece segundos sin una sola línea en
  la que era imposible saber si el OCR estaba descartando o directamente se había colgado. Son
  unas pocas líneas por minuto y ahora se ve exactamente qué midió y contra qué umbral.

- **La captura manual (Ctrl+Shift+S) actualiza la referencia del escaneo automático.** Antes, tras
  forzar una captura, el bucle seguía comparando contra la imagen vieja y repetía el OCR sobre la
  línea que acababas de traducir a mano.

- **La captura de pantalla tiene un límite de 8 segundos.** Si el sistema operativo no responde,
  se saltea ese ciclo y queda registrado, en vez de dejar el escaneo automático colgado para
  siempre y en silencio.

## [1.0.11] — un kanji de basura ya no vuelve japonés a un texto en inglés

### Arreglado

- **Con OCR, casi todas las traducciones de un juego en inglés empezaban con "Que".** La causa no
  era el traductor: PaddleOCR leía el ícono de viñeta del juego como el kanji `其`, y **un solo
  caracter japonés entre sesenta letras latinas** alcanzaba para que Tuhua declarara la línea
  entera japonesa. Google traducía inglés *como si fuera japonés* y devolvía esas frases raras. En
  el log del usuario está el A/B con la misma oración: con el `其` daba *"Que te desempeñas mal
  cuando…"*, y doce minutos después, sin él, *"Tu desempeño es deficiente cuando…"*.

  Ahora la detección distingue el ruido del texto real por cómo aparece: la basura del OCR son
  caracteres **sueltos**, mientras que el texto bilingüe de verdad viene en rachas (`設定` son dos
  kanji pegados formando una palabra). Una barra de menú japonesa con etiquetas en inglés sigue
  detectándose como japonés, sin importar cuánto texto latino la rodee.

  El mismo arreglo cubre un caso hermano que nadie había reportado: una letra cirílica suelta (el
  OCR leyendo `В` donde va una `B`) también mandaba la línea a traducirse como japonés.

### Cambiado

- La función que decide el idioma origen de **toda** traducción con auto-detectar —en todos los
  motores— pasa a tener pruebas propias. Llevaba ocho rondas de ajustes acumulados y ninguna.

## [1.0.10] — el OCR ahora sí ve cuando cambia el texto

Continuación de la v1.0.9, que arregló la compuerta equivocada. Esto es lo que faltaba.

### Arreglado

- **La detección de cambios entre capturas se perdía la mitad de los cambios de texto.** Antes de
  correr el OCR, Tuhua compara la captura nueva con la anterior para no reconocer mil veces lo
  mismo. Esa comparación miraba **200 bytes sueltos** repartidos por la imagen y exigía que 10
  difirieran: en un área de captura normal eso es mirar 200 píxeles de unos 90.000 —el 0,2% de la
  imagen, y siempre los mismos—. Como el texto son trazos finos sobre un fondo casi uniforme, la
  cantidad esperada de muestras alteradas caía justo en el umbral: **cara o cruz**. De ahí el "a
  veces escanea solo, otras hay que forzarlo con Ctrl+Shift+S" (el atajo va por otro camino y ni
  consulta esa comparación). Ahora se muestrean unos 4.000 píxeles comparando luminancia, con
  tolerancia para no confundir el antialiasing con texto nuevo.

- **Descartar una captura no dejaba ningún rastro.** Era la decisión más silenciosa de todo el
  proceso: el bucle recibía "no cambió nada" y seguía de largo sin escribir una línea. Por eso
  este problema tardó tres rondas en encontrarse. Ahora el log dice cuántas capturas seguidas se
  descartaron.

### Nuevo

- **Válvula de escape en el OCR automático.** Si se descartan ocho capturas seguidas (unos 28
  segundos), la novena corre igual. Si alguna vez la comparación vuelve a quedar ciega a un juego
  que dibuja el texto de una forma que no previmos, el peor caso pasa a ser "tarda hasta medio
  minuto" en vez de "no lo detecta nunca".

## [1.0.9] — el OCR descartaba la línea que terminaba de aparecer

### Arreglado

- **Con OCR, el texto que se revela de a poco no se traducía una vez completo.** Reportado como
  "a veces no detecta el cambio de texto", con Tesseract y con PaddleOCR. No es que no lo leyera:
  lo leía y lo descartaba por parecido al anterior. El filtro que evita retraducir la misma línea
  medía, entre otras cosas, cuánto del texto más corto coincide con el principio del más largo —
  y esa medida es ciega a la dirección: daba 100% tanto si el OCR había vuelto a leer la misma
  línea peor y más corta (descartarla está bien) como si la línea había **terminado** de aparecer
  y ahora traía más texto. En un log real la misma frase se descartó tres veces seguidas hasta
  que el usuario forzó la captura a mano. Ahora, si el texto nuevo conserva entero el anterior y
  creció al menos un 20%, se traduce. Por debajo de eso sigue tratándose como la misma línea, que
  es para lo que el filtro existía: una relectura con un caracter de ruido pegado al final no
  dispara una traducción nueva.

## [1.0.8] — dos cosas que salieron de probar la 1.0.7 en Windows

### Arreglado

- **Estando en pausa, cambiar un ajuste igual mandaba la última línea al motor de traducción.**
  La v1.0.7 arregló que no se *recordara* el texto que llegaba en pausa; faltaba la otra mitad:
  el texto recordado de antes seguía retraduciéndose al cambiar motor, idioma o plantilla. Y el
  resultado no lo veía nadie — la pausa oculta y vacía el overlay —, así que era una llamada a la
  red y nada más. Ahora en pausa no se retraduce.

- **Los botones de abajo a la derecha (Logs, Carpeta, Reportar) se salían de su recuadro** al
  angostar esa columna con el divisor arrastrable: el indicador de estado se encimaba con el
  primer botón en vez de reacomodarse. Ahora la fila baja los botones a un segundo renglón. El
  defecto existía desde que eran dos botones; con el tercero apareció antes.

## [1.0.7] — el log ya no puede filtrar tu API key

Un usuario mandó su log para diagnosticar otra cosa y adentro venía su clave de API, copiada al
portapapeles un rato antes. No hizo nada mal: el flujo que Tuhua recomienda para reportar un
problema era, tal como estaba, un flujo que filtraba credenciales.

### Arreglado

- **El archivo de log podía contener tus credenciales.** En modo Portapapeles, todo lo que
  copiás pasa por el log — y ese archivo es justamente el que los botones **Logs** y **Carpeta**
  existen para compartir. Ahora las credenciales que Tuhua reconoce (claves de OpenAI, Anthropic,
  DeepL, Google, Groq, GitHub y compañía, más cualquier cadena opaca larga) se tapan antes de
  escribirse: quedan como `sk-ant-api03-[REDACTADO]`. La consola de desarrollo no cambia, y lo
  que se manda a los motores de traducción tampoco: sólo se toca lo que se escribe al archivo.

- **Pausar no pausaba del todo.** Con la traducción en pausa, el texto entrante igual quedaba
  guardado como "lo último recibido", y el retraducir-automático que se dispara al cambiar de
  motor/idioma/plantilla lo mandaba a traducir. En el caso real, eso llevó la clave de API del
  usuario a Google Translate estando la app en pausa. Ahora, en pausa, no se guarda nada.

- **Anthropic devolvía error 400 con una plantilla de prompt personalizada.** Si la plantilla usa
  `{sentence}`, la línea a traducir viaja dentro de las instrucciones y el pedido sale sin ningún
  mensaje de usuario. OpenAI y los servidores locales lo aceptan; Anthropic lo rechaza con *"At
  least one non-system, non-developer message is required"*. Como el fallo caía al motor de
  respaldo sin decir nada, el síntoma no era un error sino "mi plantilla no hace nada". Ninguno de
  los 4 presets que vienen con Tuhua usa `{sentence}`, así que sólo afectaba a plantillas propias.

### Nuevo

- **Se pueden mandar reportes por correo a `help@tuhua.lyca.dev`.** Hasta ahora la única vía era
  abrir un Issue en GitHub, que deja afuera a quien no tiene cuenta o prefiere no reportar en
  público. La dirección está en la app en dos lugares: un botón **Reportar** al lado de Logs y
  Carpeta — donde ya está parado quien junta material para un reporte — y en el pie de la Guía de
  Inicio. Aparece escrita entera en los dos, no escondida detrás de un enlace: si la máquina no
  tiene cliente de correo configurado, el click no hace nada y hay que poder leerla igual.

### Cambiado

- **Validar una API key ahora completa la lista de modelos.** El botón ya consultaba los modelos
  del proveedor para decirte cuántos encontró, pero después tiraba la lista: el campo **Modelo**
  seguía sugiriendo sólo los 3 recomendados. Ahora se suman todos los que devuelve la API, con los
  recomendados arriba. (El campo siempre aceptó cualquier ID escrito a mano; lo que faltaba era
  poder verlos.)

## [1.0.6] — cinco cosas que un archivo de log dejó a la vista

Ronda nacida de leer una sesión real de traducción de punta a punta. Ninguno de estos cinco
problemas había sido reportado por separado: todos estaban en el mismo log.

### Arreglado

- **Activar el Portapapeles traducía lo que ya estaba copiado.** El vigilante reseteaba su
  memoria al arrancar, así que la primera lectura —medio segundo después— siempre daba por
  "nuevo" lo que hubiera en el portapapeles desde antes. Se disparaba de tres formas: al tocar
  ▶/⏸, al cambiar el intervalo de revisión en configuración (que reinicia el vigilante por
  dentro) y al abrir Tuhua en modo Portapapeles, que traducía lo último que el usuario hubiera
  copiado antes de abrir la app. En el log se ve la misma línea vieja traducida tres veces en
  tres minutos. Ahora sólo cuenta lo que se copia **después** de activar.
- **El botón "Logs" hacía que Tuhua se tradujera a sí misma.** Copiar los logs para reportar un
  problema, con el Portapapeles activo, metía el archivo de log entero en el traductor — y de
  paso en la memoria de contexto, en la memoria de traducción y en el historial. El proceso
  principal ahora avisa al vigilante que ese texto lo escribió Tuhua.
- **Google Translate devolvía comillas rotas.** `"I don't know what's going on right now."`
  llegaba al overlay como `&quot;No sé qué está pasando ahora&quot;.`: la respuesta viene
  escapada como HTML y nadie la desescapaba. Afectaba a todos los usuarios, no sólo a quienes
  eligen Google — es el motor de respaldo de todos los demás.
- **Un aviso repetido tapaba la ventana.** Los avisos se quedan en pantalla hasta que uno los
  cierra (a propósito, desde v3.13.41), y el de "falló el motor principal" salta una vez por
  línea traducida: con una clave de API inválida eso son ocho avisos idénticos en cinco
  minutos. Ahora el repetido se agrupa en uno solo con un contador (×2, ×3…).

### Cambiado

- **El aviso de motor caído ahora dice por qué.** Antes decía sólo "falló el motor principal,
  usando alternativo"; el motivo real (`HTTP 401: Invalid Anthropic API Key`) existía únicamente
  dentro del archivo de log. Por eso una clave mal puesta se sentía como "Tuhua traduce mal": la
  traducción seguía llegando, en silencio, degradada a Google Translate.
- **El log contaba mal los filtros de texto.** `Regex filter: 7 applied` era en realidad "hay 7
  filtros activos" — el mismo número en todas las líneas, incluyendo aquellas cuyo texto salía
  idéntico a como entró. Ahora es `3/7 changed the text`, que es la pregunta que uno le hace al
  log: *¿algún filtro se comió mi texto?*

## [1.0.5] — el error 400 de Anthropic era un header

### Arreglado

- **Usar Anthropic con el motor GPT daba error 400 al validar.** La capa de compatibilidad con
  OpenAI de Anthropic cubre `/chat/completions`, pero **no** `/v1/models`, que es el endpoint que
  usa el botón **Validar** — y los endpoints nativos exigen el header `anthropic-version`. Ahora
  cada proveedor puede declarar sus headers propios, con reconocimiento por dirección para quien
  llegue a Anthropic por la opción "Personalizado".
- **La lista de modelos de Anthropic estaba dos generaciones atrasada.** Elegir uno de esos
  modelos daba 404, el pipeline se lo tragaba y caía a Google Translate sin decir nada.
- Los tres avisos del botón **Logs** estaban escritos a mano en español; ahora están traducidos
  en los 8 idiomas.

## [1.0.4] — los servidores LLM locales preconfigurados no funcionaban

### Arreglado

- **Elegir Ollama (o LM Studio, llama.cpp o KoboldCpp) dejaba la dirección en `undefined`.** El
  proceso principal enviaba la lista de servidores al panel de configuración **sin la dirección
  de cada uno**, así que el campo se rellenaba con la palabra literal `undefined` y el botón
  Validar respondía `Error 0: Invalid URL`. Afectaba a los cuatro servidores por igual.
  La traducción en sí seguía funcionando —la dirección real se resolvía por otro camino, del lado
  del proceso principal— pero no había forma de comprobarlo desde la interfaz.

- **Los servidores locales fallaban con `ECONNREFUSED` estando levantados.** Los preajustes usaban
  `localhost`, que en versiones recientes de Node se resuelve primero a IPv6 (`::1`) — pero Ollama
  y compañía escuchan sólo en IPv4 por defecto. El error no daba ninguna pista de que el problema
  fuera ése; ahora los preajustes usan `127.0.0.1` directamente.
- **El modelo colaba frases suyas antes de la traducción.** Salidas como *"Aquí tienes la
  traducción al español:"* llegaban al overlay junto con el texto. El limpiador sólo reconocía
  esas frases en inglés y japonés, pero el modelo las escribe en el idioma **destino** — el mismo
  agujero que ya había tenido la detección de respuestas rechazadas. Ahora se detectan por su
  forma, sin depender del idioma, y sin tocar los diálogos que empiezan con el nombre de un
  personaje.

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
