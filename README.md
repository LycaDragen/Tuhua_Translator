# 🌺 Tuhua Translator

**Open Source Visual Novel Translator** — Traduce visual novels y juegos en tiempo real directamente en tu pantalla.

[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc/4.0/)
[![Electron](https://img.shields.io/badge/Electron-28-blue.svg)](https://www.electronjs.org/)
[![Version](https://img.shields.io/badge/version-3.13.18-emerald.svg)]()

---

## 📖 ¿Qué es Tuhua Translator?

Tuhua Translator es una aplicación de escritorio gratuita y de código abierto diseñada para traducir visual novels y juegos japoneses en tiempo real. Funciona superponiendo las traducciones directamente sobre la ventana del juego, sin necesidad de parches ni modificaciones de los archivos originales.

### ✨ Características principales

- **4 métodos de entrada**: Textractor, Portapapeles, OCR y XUAT (XUnity.AutoTranslator)
- **7 motores de traducción**: Google Translate (gratis), Bing (gratis), DeepL, OpenAI/GPT, Local LLM, LibreTranslate y Custom MT
- **Overlay transparente**: Traducciones superpuestas sobre la ventana del juego
- **Glosario personalizable**: Define traducciones específicas para nombres y términos
- **Memoria de traducción**: Caché inteligente con fuzzy matching para diálogos repetitivos
- **Perfiles por juego**: Configuraciones independientes para cada juego
- **8 idiomas de interfaz**: Español, English, 日本語, 中文, Русский, Português, Italiano, Français
- **Tema oscuro/claro**: Interfaz adaptable a tu preferencia

---

## 🚀 Instalación

### Descarga directa

Ve a la sección [Releases](https://github.com/LycaDragen/Tuhua_Translator/releases) y descarga el instalador para tu sistema operativo:

| Plataforma | Formato | Notas |
|---|---|---|
| Windows | `.exe` (NSIS) | Instalador con opción de directorio personalizado |
| Linux | `.AppImage` | Portable, no requiere instalación |
| macOS | `.dmg` | Arrastra a Aplicaciones |

### Desde el código fuente

```bash
# Clonar el repositorio
git clone https://github.com/LycaDragen/Tuhua_Translator.git
cd Tuhua_Translator

# Instalar dependencias
npm install

# Ejecutar en modo desarrollo
npm run dev

# Construir para tu plataforma
npm run build:win    # Windows
npm run build:linux  # Linux
npm run build:mac    # macOS
```

---

## 🎮 Métodos de entrada

### 🪝 Textractor (Recomendado)
Conecta con [Textractor](https://github.com/Artikash/Textractor) para extraer texto directamente de la memoria del juego. Soporta tanto conexión TCP como lanzamiento de TextractorCLI integrado.

- Extrae texto de la memoria del proceso del juego
- Soporte para hooks personalizados
- Auto-detección de hooks al lanzar juegos
- Puerto configurable (por defecto: 9251)

### 📋 Portapapeles
Monitorea el portapapeles del sistema y traduce automáticamente cualquier texto copiado. Ideal para juegos que permiten copiar texto.

### 📸 OCR
Captura una región de la pantalla y detecta el texto directamente de la imagen. Perfecto para juegos que no son compatibles con Textractor.

- **Motor por defecto: Tesseract.js** — corre sin descargas adicionales, sin depender de un binario nativo opcional (`onnxruntime-node`)
- **PaddleOCR (PP-OCRv5) disponible como motor alternativo** — modelo unificado chino+japonés (kanji, kana, texto simplificado y tradicional) más un modelo dedicado para coreano, corriendo 100% local vía ONNX Runtime, sin necesidad de Python ni conexión a internet tras la primera descarga de modelos. Recomendado para japonés/chino/coreano, o cuando la escena tiene mucho ruido visual detrás del texto
- **Detección automática de idioma** (`auto`): identifica japonés/chino/coreano por el texto reconocido y cambia de modelo sin intervención (ambos motores)
- **Filtrado geométrico de furigana** (motor PaddleOCR): descarta automáticamente las lecturas kana pequeñas que aparecen sobre el kanji, para que no contaminen el texto a traducir
- Soporte para texto vertical (縦書き) con detección y rotación automática (motor PaddleOCR)
- Captura manual o automática (intervalo configurable)

### 🎮 XUAT (XUnity.AutoTranslator)
Integra con [XUnity.AutoTranslator](https://github.com/bbepis/XUnity.AutoTranslator) para juegos Unity. Tuhua actúa como servidor de traducción y XUAT reemplaza el texto directamente dentro del juego.

- Instalación automática de BepInEx + XUAT
- Detección automática del backend (Mono/IL2CPP)
- El texto traducido aparece dentro del juego, sin overlay
- Puerto configurable (por defecto: 8419)

---

## 🔤 Motores de traducción

| Motor | Tipo | Requiere API Key | Notas |
|---|---|---|---|
| 🌐 Google Translate | Gratuito | No | Web scraping, sin límite oficial |
| 🔍 Bing Translator | Gratuito | No | Web scraping, sin límite oficial |
| 💎 DeepL API | Oficial | Sí | Alta calidad, soporta formalidad |
| 🧠 OpenAI / GPT | Oficial | Sí | Traducción contextual con IA |
| 🤖 Local LLM | Local | No | Ollama / LM Studio, 100% offline |
| 🏠 LibreTranslate | Self-hosted | Opcional | Open source, privacidad total |
| ⚙️ Custom MT | Personalizado | Opcional | Cualquier endpoint compatible |

### DeepL: Formalidad
Con DeepL puedes controlar el nivel de formalidad de la traducción, ideal para japonés (keigo/casual):
- Por defecto
- Preferir formal
- Preferir informal
- Siempre formal
- Siempre informal

### Documentación técnica

| Documento | Contenido |
|---|---|
| [`docs/translation-context-support.md`](docs/translation-context-support.md) | Qué motor soporta contexto y glosario nativo, y qué implementa Tuhua de cada uno |
| [`docs/llm-prompting.md`](docs/llm-prompting.md) | Plantillas de prompt, variables disponibles, glosario como instrucción, tabla de proveedores LLM y cómo agregar uno nuevo |

---

## 📖 Glosario

El glosario te permite definir traducciones personalizadas para nombres de personajes, términos específicos del juego y jerga que los motores de traducción no manejan bien.

- Soporte para expresiones regulares
- Prioridad configurable por entrada
- Aplicación automática antes de la traducción
- Importar/Exportar en formato JSON

---

## 💾 Memoria de traducción

La memoria de traducción almacena pares de traducciones previas y los reutiliza automáticamente. Usa fuzzy matching para detectar diálogos similares, lo que es especialmente útil en visual novels con rutas ramificadas donde los mismos diálogos se repiten con ligeras variaciones.

- Caché persistente por perfil
- Fuzzy matching para diálogos similares
- Ahorra llamadas a la API y reduce latencia
- Historial de traducciones con exportación

---

## ⌨️ Atajos de teclado

| Atajo | Acción |
|---|---|
| `Ctrl+Shift+T` | Activar/Pausar traducción |
| `Ctrl+Shift+O` | Mostrar/Ocultar overlay |
| `Ctrl+Shift+C` | Activar/Desactivar click-through |

---

## 🛠️ Tecnologías

- **[Electron](https://www.electronjs.org/)** — Framework de aplicación de escritorio
- **[Tesseract.js](https://github.com/naptha/tesseract.js)** — Motor OCR por defecto (WebAssembly)
- **[PaddleOCR (PP-OCRv5)](https://github.com/PaddlePaddle/PaddleOCR)** vía **[ONNX Runtime](https://github.com/microsoft/onnxruntime)** — OCR alternativo, corre local sin Python
- **[electron-store](https://github.com/sindresorhus/electron-store)** — Persistencia de configuración
- **[Tailwind CSS](https://tailwindcss.com/)** — Framework CSS utilitario (via CDN)

---

## 📁 Estructura del proyecto

```
tuhua-translator/
├── src/
│   ├── main/                    # Proceso principal de Electron
│   │   ├── index.js             # Punto de entrada
│   │   ├── ipc-handlers.js      # Manejadores IPC
│   │   ├── window-manager.js    # Gestión de ventanas
│   │   ├── tray.js              # Bandeja del sistema
│   │   └── shortcuts.js         # Atajos globales
│   ├── preload/                 # Scripts de precarga (seguridad IPC)
│   │   ├── main-preload.js
│   │   └── overlay-preload.js
│   └── services/                # Servicios del backend
│       ├── clipboard-watcher.js
│       ├── ocr.js
│       ├── textractor.js
│       ├── textractor-launcher.js
│       ├── xuat-server.js
│       ├── xuat-installer.js
│       └── translation/
│           ├── pipeline.js      # Orquestador central
│           ├── cache.js         # Caché LRU persistente
│           ├── translation-memory.js
│           ├── glossary.js
│           └── engines/         # Motores de traducción
│               ├── google-free.js
│               ├── bing.js
│               ├── deepl.js
│               ├── openai.js
│               ├── local-llm.js
│               ├── libretranslate.js
│               └── custom-mt.js
├── renderer/
│   ├── main/                    # Ventana principal
│   │   ├── index.html
│   │   ├── renderer.js
│   │   ├── i18n.js
│   │   └── assets/
│   ├── output-overlay/          # Overlay de traducción
│   └── capture-area/            # Área de captura OCR
├── package.json
├── LICENSE
└── .gitignore
```

---

## 🤝 Contribuir

¡Las contribuciones son bienvenidas! Si quieres contribuir:

1. Haz un Fork del repositorio
2. Crea una rama para tu feature (`git checkout -b feature/nueva-funcionalidad`)
3. Haz commit de tus cambios (`git commit -m 'Añadir nueva funcionalidad'`)
4. Haz push a la rama (`git push origin feature/nueva-funcionalidad`)
5. Abre un Pull Request

### Reportar bugs

Si encuentras un bug, por favor abre un [Issue](https://github.com/LycaDragen/Tuhua_Translator/issues) con:

- Descripción del problema
- Pasos para reproducirlo
- Tu sistema operativo y versión de Tuhua Translator
- Logs (disponibles desde el botón de Debug en la interfaz)

---

## 📜 Licencia

Este proyecto está licenciado bajo **Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)**.

Esto significa que puedes:
- ✅ **Compartir** — copiar y redistribuir el material en cualquier medio o formato
- ✅ **Adaptar** — remezclar, transformar y construir a partir del material

Bajo las siguientes condiciones:
- 📝 **Atribución** — debes dar crédito adecuado a Lyca, proporcionar un enlace a la licencia e indicar si se realizaron cambios
- 🚫 **NoComercial** — no puedes usar el material con fines comerciales

Para más detalles, consulta el archivo [LICENSE](LICENSE) o visita [creativecommons.org/licenses/by-nc/4.0](https://creativecommons.org/licenses/by-nc/4.0/).

---

## 👤 Autor

**Lyca** — [sebaguerra6@gmail.com](mailto:sebaguerra6@gmail.com)

Si te gusta este proyecto, considera dejar una ⭐ en GitHub.

---

## 🙏 Agradecimientos

### Especiales

- **ZpectralKrystal** — por el apoyo incondicional, por estar siempre ahí y por motivarme a crecer y ser mejor en todo este proceso.
- **Dust** — por regalarme la clave de Claude Pro que hizo posible llevar este proyecto hasta donde siempre quise que llegara.

### Tecnologías y proyectos open source

- [Textractor](https://github.com/Artikash/Textractor) — Extractor de texto para juegos
- [XUnity.AutoTranslator](https://github.com/bbepis/XUnity.AutoTranslator) — Plugin de traducción para Unity
- [Tesseract.js](https://github.com/naptha/tesseract.js) — Motor OCR por defecto (WebAssembly)
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) (PaddlePaddle) — OCR alternativo (PP-OCRv5)
- [DeepL](https://www.deepl.com/) — Motor de traducción de alta calidad
- [Electron](https://www.electronjs.org/) — Framework de aplicaciones de escritorio
