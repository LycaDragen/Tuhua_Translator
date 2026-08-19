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
| DeepL | `context` (líneas previas unidas con `\n`, recortado desde la más vieja si excede 2000 caracteres — tope autoimpuesto, no de DeepL) | `glossary_id` resuelto por llamada (manual por perfil, o auto-sincronizado — ver abajo) | Implementado. `model_type` configurable (`prefer_quality_optimized` por defecto). Sólo se manda un `glossary_id`, no la variante plural — ver "Fuera de alcance" |
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

## Ver también

- [`llm-prompting.md`](llm-prompting.md) — cómo Tuhua arma el prompt para
  los motores LLM, variables disponibles, glosario como instrucción, y
  cómo agregar un proveedor cloud nuevo a la tabla.
