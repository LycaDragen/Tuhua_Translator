# Soporte de contexto y glosario nativo por motor

Investigación de agosto 2026, cerrada para el overhaul de motores LLM
(punto 2 del backlog: "investigar contexto nativo por motor"). Este
documento reemplaza la investigación de scratch — tiene fecha de
vencimiento (las APIs cambian), así que vive versionado en el repo en vez
de en un plan efímero.

## Qué significa "contexto nativo" y "glosario nativo" acá

- **Contexto nativo**: el motor acepta las líneas previas del diálogo como
  dato estructurado propio (no como texto pegado a mano al principio de la
  frase), y las usa para desambiguar sin traducirlas ni facturarlas como
  si fueran parte del texto a traducir.
- **Glosario nativo**: el motor tiene un mecanismo propio (no un truco de
  prompt) para forzar que un término se traduzca siempre igual, o se deje
  sin traducir.

## Tabla comparativa

| Motor | Contexto nativo | Glosario nativo | Notas |
|---|---|---|---|
| **DeepL** | ✅ `context` — GA desde Q2 2024, **no se factura**, sin límite propio de caracteres (el único tope real es el body de 128 KiB) | ✅ `glossary_id` (un id por request; DeepL también documenta `glossary_ids` plural hasta-5, no verificado contra la API real, ver más abajo) | También `model_type` (`quality_optimized` = su LLM propio de traducción / `latency_optimized` = más rápido). Desde junio 2026 todos los pares de idiomas soportan todos los valores. La documentación de DeepL aclara explícitamente que `context` **no** es para instrucciones estilo LLM — es texto circundante real, no un system prompt |
| **OpenAI / Anthropic / Gemini / DeepSeek / OpenRouter / Groq / Ollama (y cualquier endpoint OpenAI-compatible)** | ✅ total, vía turnos de chat en `messages[]` | ✅ vía instrucción en el prompt (Tuhua construye la instrucción y aplica un mecanismo de placeholder adicional para los términos "no traducir" — ver [`llm-prompting.md`](llm-prompting.md)) | Es la familia de motores donde Tuhua invirtió más: consolidados en una sola base (`llm-base.js`), comparten sanitizador de salida, plantillas de prompt y glosario |
| **Google Cloud Translation v3** | ⚠️ "Adaptive Translation" — acepta 5 a 30.000 pares de referencia, la API elige los mejores y se los pasa a un LLM en inferencia | ✅ glossaries | Requiere credenciales de GCP y es de pago. **Tuhua no usa esto** — el motor `google-free` del repo habla contra el endpoint web gratuito (`gtx`), que no tiene nada de lo anterior |
| **Azure Translator** | ❌ | ⚠️ sólo vía Custom Translator (requiere entrenar un modelo) y un diccionario de frases simple | Tuhua no implementa este motor |
| **LibreTranslate** | ❌ | ❌ | El glosario de Tuhua se le aplica igual, pero como sustitución literal antes de mandar el texto — no hay nada del lado del motor |
| **Bing** | ❌ | ❌ | Motor roto de antes (ambos métodos de acceso fallan), sin relación con este trabajo — ver memoria del proyecto, no se tocó acá |

## Qué implementa Tuhua hoy, motor por motor

| Motor | Contexto | Glosario | Estado en Tuhua |
|---|---|---|---|
| DeepL | `context` (líneas previas unidas con `\n`, recortado desde la más vieja si excede 2000 caracteres — tope autoimpuesto, no de DeepL) | `glossary_id` resuelto por llamada (manual por perfil, o auto-sincronizado — ver abajo) | Implementado. `model_type` configurable (`prefer_quality_optimized` por defecto). Sólo se manda un `glossary_id`, no la variante plural — ver "Fuera de alcance". Además implementa `custom_instructions` (3 directivas ocultas por defecto, por perfil desde v3.13.80) y `style_id` (cableado, sin UI) — ver la sección propia abajo, no cubierta por la tabla de contexto/glosario de más arriba |
| OpenAI / OpenRouter / DeepSeek / Google Gemini / Anthropic / Groq / servidor local (LM Studio, Ollama, llama.cpp, KoboldCpp) | Turnos de chat reales para el diálogo previo, más `{contextBoth}`/`{contextOriginal}`/`{contextTranslation}` disponibles en la plantilla de prompt | Instrucción de prompt (`glossaryMode`: `literal` / `prompt` / `hybrid`, default `hybrid`) + placeholder opaco para términos que deben quedar sin traducir | Implementado, ver [`llm-prompting.md`](llm-prompting.md) para el detalle completo |
| Google Translate (`google-free`), LibreTranslate, Custom MT | ❌ (sin mecanismo nativo) | Sustitución literal antes de traducir, sin instrucción de prompt (no aplica — no son motores de prompt) | Sin cambios en este trabajo |
| Bing | ❌ | ❌ | Roto, fuera de alcance |

### DeepL: glosario automático por perfil

Un perfil de Tuhua (`profileStore`) puede sincronizar su glosario efectivo
contra la cuenta de DeepL del usuario (`deeplAutoGlossary: true`), o usar
un `glossary_id` puesto a mano (`deeplGlossaryId`) — el manual gana si
ambos están configurados. La sincronización es perezosa: sólo llama a la
API si el hash del glosario o el par de idiomas cambió desde el último
sync (`src/services/translation/deepl-glossary-sync.js`). Apagado por
defecto — subir nombres de personajes/términos a la cuenta del usuario
como recurso persistente es una decisión que el usuario toma por perfil,
no un comportamiento silencioso.

Al borrar un perfil, su glosario remoto en DeepL se borra también
(best-effort, nunca bloquea el borrado del perfil si la llamada falla).

### DeepL: `custom_instructions`, `style_id`, `translation_memory_id` — verificado contra la API real, no contra la doc

Agregado 2026-08-22, al revisar un mail promocional de DeepL contra lo que
Tuhua ya tenía implementado (`deepl.js` desde v3.11.28-29, antes de que
existiera este documento). **La documentación oficial de DeepL afirma que
`custom_instructions` y `style_id` requieren API Pro** — ver
[About style rules](https://support.deepl.com/hc/en-us/articles/20515591890204-About-style-rules).
**Esto es incorrecto**, al menos para la cuenta usada en la verificación:
probado con la key Free real de Lyca (`:fx`), pidiendo la misma frase con
instrucciones contradictorias sobre el mismo texto:

| Request | Salida |
|---|---|
| sin `custom_instructions` | `"Yuki-san, por favor, espérame en la estación."` |
| `["...replace -san with the word Senor..."]` | `"Senor Yuki, por favor, espérame en la estación."` |
| `["Use extremely archaic, formal Spanish..."]` | `"Vuestra merced, Yuki-san, ruego se digne aguardarme en la estación."` |

Las dos instrucciones cambiaron la salida de forma inconfundible — la
feature funciona en Free. Sondeo completo de esa sesión:

| Parámetro / endpoint | API Free | Estado en Tuhua |
|---|---|---|
| `custom_instructions` | ✅ funciona (verificado arriba) | Implementado, UI completa, **profile-scoped desde v3.13.80** — mismo argumento que `deeplGlossaryId`: qué instrucciones mandar depende de qué JUEGO está activo |
| `style_id` | ✅ disponible (`GET /v3/style_rules` → HTTP 200, lista vacía) | Cableado en el motor (`deepl.js`), **sin UI** y sin forma de obtener un id desde la app — habría que crear la lista de reglas en la web de DeepL primero |
| `model_type: quality_optimized` | ✅ | Implementado, configurable solo por settings, sin UI |
| `translation_memory_id` | ❌ **HTTP 403 Forbidden** — requiere plan Business/Enterprise | Cableado en el motor (se deja — 5 líneas, sirve a quien tenga ese plan). El endpoint de listado de TMs de la cuenta (`deepl-fetch-translation-memories`) se **borró** en v3.13.80: cero consumidores en el renderer y apunta a un endpoint inalcanzable en Free |

**Si una sesión futura lee la documentación oficial y concluye que hay que
gatear `custom_instructions`/`style_id` detrás de una detección de plan
Pro: no lo hagas sin repetir esta prueba primero.** Ídem el precedente ya
existente en `scripts/test-deepl-glossary-sync.js`, que documenta la misma
verificación empírica para glosarios — en este proyecto la API real le
gana a la doc del proveedor.

`deeplFormality` se dejó deliberadamente **global**, no por perfil: es un
solo eje fijo con UI que el usuario ya puede haber ajustado, un caso más
débil que instrucciones de texto libre. Si en el futuro alguien pide
formalidad distinta por juego, ahí se reconsidera.

## Fuera de alcance (decisiones explícitas, no huecos)

- **`glossary_ids` plural (hasta 5) de DeepL**: no implementado. No se pudo
  verificar contra la API real sin arriesgar comportamiento no probado, y
  un perfil de Tuhua representa una VN con un glosario efectivo — un solo
  `glossary_id` alcanza para el caso de uso real.
- **Google Cloud Translation v3 (Adaptive Translation)**: sería un motor
  nuevo, de pago, con credenciales GCP — no es una mejora a un motor
  existente. Fuera de alcance de este trabajo.
- **Azure Translator, motor nuevo**: Tuhua no lo implementa hoy; no forma
  parte de este trabajo.
- **Motor Bing**: roto de antes, documentado aparte, no se toca acá.
- **UI para `style_id`**: funciona en Free (ver la sección de arriba), pero
  exige crear la lista de reglas en la web de DeepL primero — `custom_instructions`
  cubre el mismo caso sin salir de la app. Solo valdría la pena si alguien
  necesita reusar >10 instrucciones entre herramientas.
- **`translation_memory_id`**: 403 en Free, requiere Business/Enterprise
  (ver arriba). Tuhua ya tiene TM local con fuzzy matching, offline, sin
  plan, aislada por perfil — mejor para este caso de uso.
- **Migrar glosarios a la API v3** (multilingües, editables): el sync v2
  actual es lazy por hash y funciona; beneficio marginal frente al costo de
  migrar el delete+create.

## Ver también

- [`llm-prompting.md`](llm-prompting.md) — cómo Tuhua arma el prompt para
  los motores LLM, variables disponibles, glosario como instrucción, y
  cómo agregar un proveedor cloud nuevo a la tabla.
