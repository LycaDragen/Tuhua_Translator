/**
 * Update Checker (v1.0.1)
 *
 * Detecta si hay una versión nueva de Tuhua publicada en GitHub Releases y,
 * donde se puede, la descarga e instala. Nace de un incidente real: el .exe y
 * el .AppImage del release v3.13.120 no abrían ("Cannot find module 'conf'"),
 * se arreglaron y se reemplazaron los assets, pero no había ninguna forma de
 * avisarle a quien ya se había bajado el instalador roto.
 *
 * ── El eje de partición es CAPACIDAD, no plataforma ──────────────────────
 * Partir por `process.platform === 'darwin'` sería incorrecto: hay tres casos
 * más que tampoco pueden auto-instalarse, y uno de ellos es el dev run — si el
 * modo se decidiera por plataforma, no se podría probar nada de la UI
 * localmente. Los cuatro casos "sólo aviso" son:
 *   - !app.isPackaged        → dev / CDP
 *   - darwin                 → Squirrel.Mac rechaza updates sin firma de Apple
 *   - linux sin $APPIMAGE    → AppImage extraído o dist/linux-unpacked
 *   - AppImage no escribible → electron-updater escribe el AppImage nuevo
 *                              SOBRE $APPIMAGE; detectarlo acá evita fallar
 *                              después de bajar 130 MB
 *
 * ── El require de electron-updater es PEREZOSO y va en try/catch ─────────
 * Deliberado, no por estilo: si el módulo no quedara dentro del asar (ver el
 * bug de 'conf' de arriba, que era exactamente eso), un require de top-level
 * haría que NO ARRANQUE LA APP ENTERA, no sólo el updater. Así, en el peor
 * caso, degrada a modo 'notify' y el resto de Tuhua sigue funcionando.
 *
 * Este servicio no conoce windowManager ni ipcMain — sólo emite, igual que
 * XuatInstaller y TextractorLauncher. src/main/index.js reenvía al renderer.
 */
const EventEmitter = require('events');
const fs = require('fs');
const { app, shell } = require('electron');
const axios = require('axios');
const log = require('electron-log');

const GITHUB_OWNER = 'LycaDragen';
const GITHUB_REPO = 'Tuhua_Translator';
const RELEASES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

// El chequeo de arranque va con delay para no competir con la inicialización
// (que ya arranca Textractor/OCR/XUAT según el método de entrada).
const STARTUP_DELAY_MS = 30000;

// Modo 'notify': cachear para no pegarle a la API en cada relanzamiento. El
// límite de GitHub sin autenticar es 60 req/h por IP. Es una propiedad de
// instancia, no del módulo, así dispose() la limpia y dos instancias no
// comparten estado.
const NOTIFY_CACHE_MS = 60 * 60 * 1000;

class UpdateChecker extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this._mode = null;              // resuelto perezosamente, ver _resolveMode()
    this._autoUpdater = null;
    this._listenersBound = false;
    this._busy = false;
    this._startupTimer = null;
    this._disposed = false;
    this._lastCheckWasManual = false;
    this._lastFetch = null;         // { at, data } — cache de modo 'notify'
    this._status = {
      state: 'idle',
      version: null,
      currentVersion: app.getVersion(),
      releaseUrl: RELEASES_PAGE,
      canAutoInstall: false,
      error: null
    };
  }

  // ─── Modo ──────────────────────────────────────────────────────────────

  _resolveMode() {
    if (this._mode) return this._mode;

    // El gancho de testing SÓLO existe fuera de un build empaquetado, para que
    // no sea alcanzable por un usuario real seteando una variable de entorno.
    if (process.env.TUHUA_FAKE_UPDATE && !app.isPackaged) {
      this._mode = 'fake';
      return this._mode;
    }
    if (!app.isPackaged) { this._mode = 'notify'; return this._mode; }
    if (process.platform === 'darwin') { this._mode = 'notify'; return this._mode; }

    if (process.platform === 'linux') {
      const appImagePath = process.env.APPIMAGE;
      if (!appImagePath) { this._mode = 'notify'; return this._mode; }
      // electron-updater reemplaza el AppImage in-place. Si no es escribible
      // (instalado en /opt, montado read-only), la descarga fallaría recién al
      // final — mejor no ofrecer el botón.
      try {
        fs.accessSync(appImagePath, fs.constants.W_OK);
      } catch {
        log.info('[Updater] AppImage no escribible, modo sólo-aviso:', appImagePath);
        this._mode = 'notify';
        return this._mode;
      }
    }

    this._mode = 'full';
    return this._mode;
  }

  _canAutoInstall() {
    const mode = this._resolveMode();
    // En modo fake el flag lo decide el escenario, para poder ejercitar las
    // dos ramas del banner (con y sin auto-instalación) desde WSL.
    if (mode === 'fake') return process.env.TUHUA_FAKE_UPDATE !== 'available-mac';
    return mode === 'full';
  }

  // ─── electron-updater (modo 'full') ────────────────────────────────────

  _ensureUpdater() {
    if (this._autoUpdater) return this._autoUpdater;
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.logger = log;
      // La regla del proyecto: "suggest, don't decide for the user". Nada se
      // baja sin que el usuario haga click en Descargar.
      autoUpdater.autoDownload = false;
      // Se deja en true a propósito: el click en Descargar YA fue el
      // consentimiento explícito; instalar al salir es la terminación natural
      // de esa decisión, no una decisión nueva. Sin esto, quien elige "Más
      // tarde" bajó 130 MB que nunca se instalan. El banner lo dice
      // (update_ready_note).
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.allowPrerelease = false;

      // Feed alternativo para probar el ciclo completo sin publicar nada al
      // release público. Igual que TUHUA_FAKE_UPDATE, sólo fuera del build.
      if (process.env.TUHUA_UPDATE_FEED && !app.isPackaged) {
        autoUpdater.setFeedURL({ provider: 'generic', url: process.env.TUHUA_UPDATE_FEED });
        autoUpdater.forceDevUpdateConfig = true;
      }

      this._bindUpdaterListeners(autoUpdater);
      this._autoUpdater = autoUpdater;
      return autoUpdater;
    } catch (err) {
      // Ver el doc-comment de arriba: degradar, nunca romper el arranque.
      log.error('[Updater] electron-updater no disponible, degradando a sólo-aviso:', err.message);
      this._mode = 'notify';
      return null;
    }
  }

  /**
   * Los listeners se registran UNA sola vez. XuatInstaller registra los suyos
   * dentro del handler IPC, lo cual es seguro sólo porque construye un
   * installer nuevo por invocación; el updater es un singleton, así que copiar
   * ese patrón acumularía un listener por cada click en Descargar (progreso
   * duplicado, triplicado...).
   */
  _bindUpdaterListeners(autoUpdater) {
    if (this._listenersBound) return;
    this._listenersBound = true;

    autoUpdater.on('update-available', (info) => {
      if (this._isSkipped(info.version)) {
        log.info('[Updater] versión ignorada por el usuario:', info.version);
        this._busy = false;
        this._emitStatus({ state: 'idle', version: null });
        return;
      }
      this._busy = false;
      this._emitStatus({ state: 'available', version: info.version, error: null });
    });

    autoUpdater.on('update-not-available', () => {
      this._busy = false;
      this._emitStatus({ state: 'up-to-date', version: null, error: null });
    });

    autoUpdater.on('download-progress', (p) => {
      this.emit('progress', {
        percent: Math.round(p.percent || 0),
        transferred: p.transferred,
        total: p.total,
        bytesPerSecond: p.bytesPerSecond
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      this._busy = false;
      this._emitStatus({ state: 'downloaded', version: info.version, error: null });
    });

    autoUpdater.on('error', (err) => {
      this._busy = false;
      log.error('[Updater] error:', err);
      // Un usuario sin internet al arrancar no merece una caja de error. Sólo
      // se muestra si el chequeo lo pidió él.
      if (this._lastCheckWasManual) {
        this._emitStatus({ state: 'error', error: err.message || String(err) });
      } else {
        this._emitStatus({ state: 'idle', error: null });
      }
    });
  }

  // ─── API pública ───────────────────────────────────────────────────────

  scheduleStartupCheck() {
    if (this.store.get('autoCheckUpdates') === false) {
      log.info('[Updater] chequeo automático desactivado por el usuario');
      return;
    }
    this._startupTimer = setTimeout(() => {
      this._startupTimer = null;
      this.check({ manual: false }).catch((err) => {
        log.error('[Updater] chequeo de arranque falló:', err.message);
      });
    }, STARTUP_DELAY_MS);
  }

  async check({ manual = false } = {}) {
    if (this._disposed) return this.getStatus();
    // electron-updater no deduplica checks concurrentes, y el timer de 30s
    // puede solaparse con un click manual.
    if (this._busy) return this.getStatus();

    this._lastCheckWasManual = manual;
    this._busy = true;
    this._emitStatus({ state: 'checking', error: null });

    const mode = this._resolveMode();
    log.info(`[Updater] chequeando (modo=${mode}, manual=${manual}, versión actual=${app.getVersion()})`);
    try {
      if (mode === 'fake') return await this._runFakeScenario();
      if (mode === 'full') {
        const updater = this._ensureUpdater();
        if (updater) {
          // Los eventos de electron-updater resuelven el estado final; acá
          // sólo se dispara. _busy lo liberan los listeners.
          await updater.checkForUpdates();
          return this.getStatus();
        }
        // _ensureUpdater falló y degradó a 'notify' — seguir por esa rama.
      }
      return await this._checkViaGitHubApi({ manual });
    } catch (err) {
      this._busy = false;
      log.error('[Updater] check falló:', err.message);
      if (manual) this._emitStatus({ state: 'error', error: err.message });
      else this._emitStatus({ state: 'idle', error: null });
      return this.getStatus();
    }
  }

  async download() {
    if (!this._canAutoInstall()) {
      return { success: false, error: 'not-supported' };
    }
    const updater = this._ensureUpdater();
    if (!updater) return { success: false, error: 'not-supported' };
    if (this._busy) return { success: false, error: 'busy' };

    this._busy = true;
    this._emitStatus({ state: 'downloading', error: null });
    // No se await-ea: el handler IPC devuelve al ARRANCAR la descarga, y el
    // progreso viaja por el canal de eventos. Los errores los toma el
    // listener 'error' del updater.
    updater.downloadUpdate().catch((err) => {
      this._busy = false;
      log.error('[Updater] descarga falló:', err.message);
      this._emitStatus({ state: 'error', error: err.message });
    });
    return { success: true };
  }

  install() {
    if (!this._canAutoInstall() || !this._autoUpdater) {
      return { success: false, error: 'not-supported' };
    }
    // isSilent=false a propósito: sin firma de código, SmartScreen o UAC
    // pueden bloquear un instalador silencioso SIN UI visible — la app se
    // cerraría y no volvería, sin explicación. Mostrar el instalador es más
    // ruidoso, pero es donde el usuario puede aprobar.
    setImmediate(() => {
      try {
        this._autoUpdater.quitAndInstall(false, true);
      } catch (err) {
        log.error('[Updater] quitAndInstall falló:', err.message);
      }
    });
    return { success: true };
  }

  openReleasePage() {
    // La URL sale del estado del servicio, nunca del renderer — mismo criterio
    // que open-docs-link: no se expone una primitiva de abrir-URL-arbitraria.
    const url = this._status.releaseUrl || RELEASES_PAGE;
    shell.openExternal(url);
    return { success: true };
  }

  skipCurrent() {
    const version = this._status.version;
    if (!version) return { success: false, error: 'no-version' };
    this.store.set('skippedUpdateVersion', version);
    log.info('[Updater] versión ignorada:', version);
    this._emitStatus({ state: 'idle', version: null, error: null });
    return { success: true, version };
  }

  getStatus() {
    return { ...this._status, canAutoInstall: this._canAutoInstall() };
  }

  dispose() {
    this._disposed = true;
    if (this._startupTimer) {
      clearTimeout(this._startupTimer);
      this._startupTimer = null;
    }
    this._lastFetch = null;
    this.removeAllListeners();
  }

  // ─── Interno ───────────────────────────────────────────────────────────

  _isSkipped(version) {
    // Comparación EXACTA, no <=: si el usuario ignora 1.0.2 y sale 1.0.3,
    // tiene que volver a avisar.
    return !!version && this.store.get('skippedUpdateVersion') === version;
  }

  _emitStatus(partial) {
    const prevState = this._status.state;
    this._status = {
      ...this._status,
      ...partial,
      currentVersion: app.getVersion(),
      canAutoInstall: this._canAutoInstall()
    };
    const s = this._status;
    // 'checking' es transitorio y se emite en cada chequeo; loguearlo llenaría
    // el log sin aportar. El resto de las transiciones sí: son exactamente lo
    // que hay que poder leer cuando alguien reporta "no me apareció nada".
    if (s.state !== 'checking' && s.state !== prevState) {
      log.info(`[Updater] estado: ${prevState} → ${s.state}` +
        (s.version ? ` (v${s.version}, auto-instalable=${s.canAutoInstall})` : '') +
        (s.error ? ` error="${s.error}"` : ''));
    }
    this.emit('status', this.getStatus());
  }

  async _checkViaGitHubApi({ manual }) {
    let release;
    const cached = this._lastFetch;
    if (!manual && cached && (Date.now() - cached.at) < NOTIFY_CACHE_MS) {
      release = cached.data;
    } else {
      const res = await axios.get(RELEASES_API, {
        timeout: 8000,
        headers: {
          // Obligatorio: sin User-Agent la API de GitHub devuelve 403 (no un
          // rate-limit), y el error resultante es confuso de diagnosticar.
          'User-Agent': 'Tuhua-Translator',
          'Accept': 'application/vnd.github+json'
        }
      });
      release = res.data;
      this._lastFetch = { at: Date.now(), data: release };
    }

    this._busy = false;

    // /releases/latest ya excluye drafts y pre-releases — que es justo lo que
    // hace que marcar v3.13.120 como pre-release funcione en esta rama igual
    // que en la de electron-updater.
    const latest = String(release.tag_name || '').replace(/^v/, '');
    const current = app.getVersion();
    const releaseUrl = release.html_url || RELEASES_PAGE;

    if (!latest || !this._isNewer(latest, current)) {
      this._emitStatus({ state: 'up-to-date', version: null, releaseUrl, error: null });
      return this.getStatus();
    }
    if (this._isSkipped(latest)) {
      this._emitStatus({ state: 'idle', version: null, releaseUrl, error: null });
      return this.getStatus();
    }
    this._emitStatus({ state: 'available', version: latest, releaseUrl, error: null });
    return this.getStatus();
  }

  /** Comparador semver mínimo. No se usa la dep `semver` porque esta rama
   *  tiene que funcionar aunque electron-updater no esté disponible. */
  _isNewer(a, b) {
    const parse = (v) => String(v).replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
    const [aMaj, aMin, aPatch] = parse(a);
    const [bMaj, bMin, bPatch] = parse(b);
    if (aMaj !== bMaj) return aMaj > bMaj;
    if (aMin !== bMin) return aMin > bMin;
    return aPatch > bPatch;
  }

  /**
   * Gancho de verificación. Sin esto, los 7 estados del banner son
   * inalcanzables en WSL y sólo se verían por primera vez en una máquina real.
   * 'downloaded' es alcanzable DIRECTO, no sólo como final de 'downloading':
   * es el estado emerald, el más importante para el usuario, y barrerlo en las
   * 8 locales a través de la secuencia completa costaría ~6s por locale.
   */
  async _runFakeScenario() {
    const scenario = process.env.TUHUA_FAKE_UPDATE;
    const fakeVersion = '1.0.2';
    this._busy = false;

    if (scenario === 'error') {
      this._emitStatus({ state: 'error', version: null, error: 'fake' });
      return this.getStatus();
    }
    if (scenario === 'downloaded') {
      this._emitStatus({ state: 'downloaded', version: fakeVersion, error: null });
      return this.getStatus();
    }
    if (scenario === 'downloading') {
      this._emitStatus({ state: 'downloading', version: fakeVersion, error: null });
      let percent = 0;
      const tick = setInterval(() => {
        if (this._disposed) { clearInterval(tick); return; }
        percent += 5;
        this.emit('progress', {
          percent, transferred: percent * 1310720, total: 131072000, bytesPerSecond: 2500000
        });
        if (percent >= 100) {
          clearInterval(tick);
          this._emitStatus({ state: 'downloaded', version: fakeVersion, error: null });
        }
      }, 300);
      return this.getStatus();
    }
    // 'available' y 'available-mac' — la diferencia la resuelve
    // _canAutoInstall() leyendo el escenario.
    this._emitStatus({ state: 'available', version: fakeVersion, error: null });
    return this.getStatus();
  }
}

module.exports = UpdateChecker;
