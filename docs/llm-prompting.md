# Prompting en los motores LLM

Cómo Tuhua arma el prompt que le manda a un motor LLM (OpenAI, OpenRouter,
DeepSeek, Google Gemini, Anthropic, Groq, o un servidor local
OpenAI-compatible como LM Studio/Ollama/llama.cpp/KoboldCpp), qué variables
hay disponibles, cómo funciona el glosario para estos motores, y cómo
agregar un proveedor cloud nuevo. Ver también
[`translation-context-support.md`](translation-context-support.md) para la
comparación de qué soporta cada motor de traducción, LLM o no.

## Plantilla de prompt

El `system prompt` es una plantilla de texto con variables (setting
`promptTemplate`, global). Antes de esto, escribir un prompt custom
**reemplazaba** el prompt por defecto entero — perdiendo silenciosamente
los nombres de idioma y los ejemplos few-shot. Ahora es aditivo: cualquier
variable no usada simplemente no aparece.

### Variables disponibles

| Variable | Qué resuelve | Se puede quedar vacía |
|---|---|---|
| `{sentence}` | La línea a traducir | No |
| `{srclang}` / `{tgtlang}` | Nombre completo del idioma origen/destino | No |
| `{srclangcode}` / `{tgtlangcode}` | Código de idioma (`ja`, `es`, ...) | No |
| `{inputMethod}` | De dónde viene el texto (Textractor, Portapapeles, OCR, XUAT) | No, una vez resuelto por el pipeline |
| `{contextBoth}` / `{contextBoth[N]}` | Líneas previas como `origen → traducción` | Sí |
| `{contextOriginal}` / `{contextOriginal[N]}` | Sólo el lado origen de las líneas previas | Sí |
| `{contextTranslation}` / `{contextTranslation[N]}` | Sólo el lado traducido de las líneas previas | Sí |
| `{glossary}` | Bloque de instrucción de glosario (ver más abajo) | Sí |
| `{game}` | Nombre del perfil activo | Sí |
| `{vnTitle}` | Título de la VN según su ficha de VNDB en el perfil | Sí |
| `{speaker}` | Nombre del hablante, si se pudo extraer de la línea | Sí |
| `{ocrNote}` | Nota adicional cuando el texto viene de OCR | Sí |

El sufijo `[N]` en las tres variables de contexto limita a las N líneas
más recientes (`{contextBoth[3]}` = últimas 3 líneas, no las 3 más
viejas — el contexto se guarda de más vieja a más nueva).

**Regla de colapso**: si TODAS las variables de una línea de la plantilla
son de las que se pueden quedar vacías, y todas resuelven a vacío, la
línea entera desaparece — incluido el texto literal alrededor. Así
`- Title: {vnTitle}` con `vnTitle` vacío no deja un `- Title:` colgando.
Una variable desconocida (typo) NO se borra en silencio: se deja literal
en el texto y se reporta como warning — es la protección directa contra
el bug real que motivó este sistema (`{TEXT}` viajando sin resolver al
modelo).

Si la plantilla usa `{sentence}` en algún punto, el texto a traducir viaja
ahí y no se agrega ningún turno de chat aparte — tampoco los ejemplos
few-shot (ver más abajo), aunque estén activados: agregarlos dejaría la
conversación terminando en un turno `assistant` sin ningún `user` final
pidiéndole nada al modelo, lo que en la práctica produce una respuesta
vacía en vez de un error. Si la plantilla no usa `{sentence}` (caso de
los 4 presets de fábrica), el texto viaja como el último turno `user`,
después del prompt de sistema y los ejemplos few-shot si están activados
— mismo comportamiento que la app tenía antes de que existiera este
sistema de plantillas.

### Presets de fábrica

Cuatro presets comparten la misma estructura base y difieren sólo en el
tono de traducción (reglas 5 y 7 de la plantilla):

| Preset | Enfoque |
|---|---|
| **Balanceado** (default) | Traducción por sentido, natural en el idioma destino |
| **Literal** | Prioriza fidelidad a estructura y elección de palabras del original |
| **Localizado** | Adapta modismos, chistes y referencias culturales para que funcionen en el idioma destino |
| **Sin censura** | Igual que Balanceado, pero con la regla de contenido explícito reforzada explícitamente por sobre cualquier instinto de moderación del modelo |

Editar la plantilla a mano (sección "Avanzado" en Settings) desincroniza
el selector de preset — el `<select>` sólo marca un preset como activo si
el texto guardado es byte-idéntico al de ese preset.

### Ejemplos few-shot

Independiente de la plantilla — setting `llmFewShot` (default activado),
excepto cuando la plantilla usa `{sentence}` (ver arriba): ahí se omiten
siempre, sin importar el setting.
Agrega 2 turnos de ejemplo por par de idiomas soportado (`ja→es`, `ja→en`,
`zh→es`, `ko→en`, `en→es`) antes del texto a traducir, elegidos para
enseñar honoríficos y traducción de fragmentos. Un par no cubierto por la
tabla simplemente no agrega ejemplos — no es un error.

## Glosario como instrucción de prompt

Setting `glossaryMode`, global, con tres valores:

| Modo | Qué hace |
|---|---|
| `literal` | Comportamiento pre-overhaul: sustitución de texto antes de mandar al motor, sin instrucción de prompt. Válido para cualquier motor |
| `prompt` | Sólo instrucción de prompt (bloque `{glossary}`) — deja que el modelo aplique el renderizado guiado por la instrucción, sin sustitución literal previa |
| `hybrid` **(default)** | Sustitución literal para los términos de renderizado (`origen≠destino`) **más** instrucción de prompt | 

`hybrid`/`prompt` sólo aplican para motores con `capabilities.glossaryPrompt`
(hoy: todos los LLM listados arriba). Cualquier motor sin esa capability
(DeepL, Google Translate, LibreTranslate, Custom MT) siempre usa `literal`
sin importar el setting — no tienen forma de recibir una instrucción de
prompt.

### Por qué `hybrid` es el default, no `prompt`

Medido contra dos motores reales antes de decidir: con OpenAI, la
instrucción de prompt sola llega a 100% de cumplimiento. Con un modelo
local de 3B (Qwen2.5-3B-Instruct vía Ollama), sólo 81.8% — empata con
`literal`, no lo supera. Un solo setting global no puede asumir qué tan
capaz es el modelo local de cada usuario, así que el default no depende
de una instrucción que un modelo chico puede ignorar.

### Términos "no traducir" — mecanismo de placeholder

Para una entrada de glosario donde `origen === destino` (el caso típico
de un import de VNDB: nombres propios que deben quedar exactamente
igual), la sustitución literal es un no-op por definición — reemplazar
`桜花学園` por `桜花学園` no cambia nada, así que el modelo sigue viendo
el término en japonés y puede traducirlo igual, sin importar qué diga la
instrucción de prompt.

Por eso estos términos se enmascaran ANTES de mandar el texto al motor:
cada aparición se reemplaza por un token opaco (`⟦N⟧`), y se restaura por
el término real después de la respuesta. El modelo nunca llega a ver el
término original, así que no depende de que obedezca ninguna instrucción.
Incluye una corrección de espaciado (cualquier límite letra/dígito
excepto CJK↔CJK) para el caso en que el modelo pega el token sin espacio
al texto vecino.

Esto sólo cubre entradas exactas o case-insensitive con `origen===destino`
— las entradas tipo `regex` quedan fuera del masking (mismo criterio que
el bloque de instrucción de prompt), y las entradas de renderizado
(`origen≠destino`) no tienen protección de este tipo: dependen de la
sustitución literal (en modo `hybrid`) más la instrucción.

## Contrato de datos que llega al motor

Además del texto y las variables de plantilla, cada llamada a un motor
LLM incluye:

- **`speaker`**: extraído de la línea cruda antes de que los filtros de
  limpieza (comillas, tags de markup) la destruyan. Se detectan dos
  formas: `<Nombre>diálogo` y `Nombre「diálogo」`.
- **`game`** / **`vnTitle`** / **`inputMethod`**: resueltos del perfil
  activo y de la configuración de entrada actual, sin que el usuario
  tenga que escribir nada.

Estos cuatro datos son los que pueblan `{speaker}`/`{game}`/`{vnTitle}`/
`{inputMethod}` en la plantilla — antes de esto resolvían siempre vacío
(hueco documentado como transitorio en su momento).

## Saneamiento de la salida

Antes de que una respuesta del modelo llegue a caché/memoria de
traducción/pantalla, pasa por un sanitizador (`llmSanitize`, default
activado) que detecta y maneja, en orden: salida vacía, corte por límite
de tokens (`truncated` — no se cachea), bloques de razonamiento
(`<think>`) de modelos como DeepSeek-R1/QwQ, fences de markdown, preámbulo
tipo "Here is the translation:", comillas envolventes añadidas por el
modelo, **rechazo del modelo** (dos señales combinadas: frase conocida de
negativa + longitud desproporcionada o script equivocado para el idioma
destino), passthrough sin traducir, y notas de traductor en párrafo
aparte. Un rechazo o un passthrough nunca se guarda en caché/TM/contexto
— el pipeline cae al motor de respaldo en su lugar.

## Tabla de proveedores cloud

Los proveedores de la tabla (`src/services/translation/llm-providers.js`)
comparten un único adaptador (`llm-base.js`) porque todos hablan el mismo
formato `/chat/completions` compatible con OpenAI — agregar uno nuevo es
una fila de datos, no una clase nueva.

| Proveedor | Requiere key | Notas |
|---|---|---|
| OpenAI | Sí | Modelos de razonamiento (`o*`) usan `max_completion_tokens` en vez de `max_tokens` y no aceptan temperatura/top_p custom |
| OpenRouter | Sí | Una sola key llega a modelos de OpenAI/Anthropic/Google/DeepSeek/Meta y más |
| DeepSeek | Sí | `deepseek-reasoner` no acepta temperatura/top_p, pero sí `max_tokens` (a diferencia de los modelos de razonamiento de OpenAI) |
| Google Gemini | Sí | Vía su capa de compatibilidad OpenAI |
| Anthropic | Sí | Marcado como beta en la UI — su capa de compatibilidad OpenAI es beta según la propia documentación de Anthropic. **Esa capa sólo cubre `/chat/completions`**: `GET /v1/models` (lo que consulta «Validar») es endpoint nativo y exige el header `anthropic-version`, que llega vía `extraHeaders` |
| Groq | Sí | Enfocado en velocidad de inferencia |
| Custom | Opcional | Escape hatch para cualquier endpoint OpenAI-compatible no listado |

Servidor local (motor `local-llm`, sin key): presets de puerto para LM
Studio (`:1234`), Ollama (`:11434`), llama.cpp (`:8080`) y KoboldCpp
(`:5001`), o una URL custom.

### Cómo agregar un proveedor cloud nuevo

**Header extra:** si el proveedor exige algún header más allá de `Content-Type` y el
`Authorization: Bearer`, va declarado como `extraHeaders` en su fila —`getExtraHeaders()`
lo resuelve para el request y para «Validar». Es el mismo criterio que
`getRequestParamOverrides()`: una rareza de proveedor es un dato en la tabla, no un `if`
en el punto de llamada.

1. Agregar una entrada al array `CLOUD_PROVIDERS` en
   `src/services/translation/llm-providers.js`: `id`, `labelKey` (clave de
   i18n), `displayName` (nombre en inglés para logs, no traducido),
   `baseUrl` (**sin** `/` final — `llm-base.js` concatena directo),
   `authScheme`, `requiresKey`, `defaultModel`, `models` (lista para el
   `<datalist>` del modelo), `maxTokensField`, `supportsTopP`, `docsUrl`.
2. Si el proveedor tiene un modelo de razonamiento que rechaza
   temperatura/top_p y/o requiere `max_completion_tokens` en vez de
   `max_tokens`: agregar `reasoningModelPattern` (regex contra el nombre
   del modelo) y, sólo si aplica, `reasoningModelUsesMaxCompletionTokens:
   true`. Ninguno de los dos flags se infiere del otro — son por
   proveedor, no un comportamiento genérico de "modelo de razonamiento".
3. Agregar la clave `labelKey` a los 8 locales de `renderer/main/i18n.js`.
4. Correr `node scripts/test-llm-providers.js` — el banco valida, entre
   otras cosas, que ningún `baseUrl` termine en `/` (protección directa
   contra el bug de doble slash encontrado con Google Gemini/Anthropic).

No hace falta tocar `llm-base.js`, `openai.js` ni `local-llm.js` — ninguno
sabe qué proveedores existen, sólo leen la tabla.

## Ver también

- [`translation-context-support.md`](translation-context-support.md) —
  contexto y glosario nativo comparado entre todos los motores de
  traducción de Tuhua, LLM y no-LLM.
