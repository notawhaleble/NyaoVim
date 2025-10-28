"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = require("path");
const fs_1 = require("fs");
const electron_1 = require("electron");
const crypto_1 = require("crypto");
const mkdirp_1 = require("mkdirp");
const menu_1 = require("./menu");
const browser_config_1 = require("./browser-config");
const global_state_1 = require("./global-state");
const GPU_SWITCHES = [
    ['enable-gpu-rasterization', undefined],
    ['enable-zero-copy', undefined],
    ['enable-oop-rasterization', undefined],
    ['enable-accelerated-2d-canvas', undefined],
    ['enable-features', 'CanvasOopRasterization,Canvas2DLayers,UseSkiaRenderer'],
    ['disable-features', 'PostQuantumKyber,PostQuantumKyberWithoutPqkeyMaterial'],
];
GPU_SWITCHES.forEach(([name, value]) => {
    if (value !== undefined) {
        electron_1.app.commandLine.appendSwitch(name, value);
    }
    else {
        electron_1.app.commandLine.appendSwitch(name);
    }
});
const SPOOFED_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.240 Safari/537.36';
electron_1.app.userAgentFallback = SPOOFED_USER_AGENT;
if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = electron_1.app.isPackaged ? 'production' : 'development';
}
if (process.argv.indexOf('--help') !== -1) {
    console.log(`OVERVIEW: NyaoVim; Web-enhanced Extensible Neovim Frontend

USAGE: nyaovim [options] [neovim args...]

OPTIONS:
  --no-detach : Don't detach the editor process
  --help      : Show this help
  --version   : Show versions of NyaoVim, Electron, Chrome, Node.js, and V8
`);
    electron_1.app.exit();
}
if (process.argv.indexOf('--version') !== -1) {
    const vs = process.versions;
    const versions = ['electron', 'chrome', 'node', 'v8'].map((n) => `  ${n} : ${vs[n]}`).join('\n');
    console.log(`${electron_1.app.getName()} version ${electron_1.app.getVersion()}
${versions}
`);
    electron_1.app.exit();
}
process.on('unhandledRejection', (reason, p) => {
    console.error('Fatal: Unhandled rejection at: Promise', p, 'Reason:', reason);
});
const is_run_from_npm_package_on_darwin = electron_1.app.getAppPath().indexOf('/NyaoVim.app/') === -1;
const config_dir_name = process.platform !== 'darwin' ?
    electron_1.app.getPath('appData') :
    process.env.XDG_CONFIG_HOME || (0, path_1.join)(process.env.HOME, '.config');
const pendingOpenFiles = [];
let rendererContents = null;
let appReady = false;
const configuredCaptureSessions = new WeakSet();
function configureCaptureSession(targetSession) {
    if (configuredCaptureSessions.has(targetSession)) {
        return;
    }
    configuredCaptureSessions.add(targetSession);
    targetSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
        console.info('[nyaovim] Permission request', {
            permission,
            details,
        });
        if (permission === 'display-capture') {
            callback(true);
            return;
        }
        if (permission === 'media') {
            const mediaDetails = details && typeof details === 'object' ?
                details :
                undefined;
            const mediaTypes = Array.isArray(mediaDetails === null || mediaDetails === void 0 ? void 0 : mediaDetails.mediaTypes) ? mediaDetails === null || mediaDetails === void 0 ? void 0 : mediaDetails.mediaTypes : [];
            if (mediaTypes.length === 0) {
                console.info('[nyaovim] Allowing media request with unspecified types');
                callback(true);
                return;
            }
            const allowsCapture = mediaTypes.some(type => type === 'video' || type === 'audio');
            if (allowsCapture) {
                console.info('[nyaovim] Allowing media request', { mediaTypes });
                callback(true);
                return;
            }
        }
        callback(false);
    });
    targetSession.setDisplayMediaRequestHandler((request, callback) => __awaiter(this, void 0, void 0, function* () {
        console.info('[nyaovim] Display media request', {
            audioRequested: request.audioRequested,
            videoRequested: request.videoRequested,
            userGesture: request.userGesture,
        });
        try {
            const sources = yield electron_1.desktopCapturer.getSources({ types: ['screen', 'window'] });
            console.info('[nyaovim] Available display media sources', sources.map(source => ({
                id: source.id,
                name: source.name,
            })));
            const preferredSource = sources.find(source => source.id.startsWith('screen:')) || sources[0];
            if (!preferredSource) {
                console.warn('[nyaovim] No display media sources available');
                callback({});
                return;
            }
            callback({
                video: { id: preferredSource.id, name: preferredSource.name },
                audio: request.audioRequested ? 'loopback' : undefined,
            });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[nyaovim] Failed to fulfill display media request:', message);
            callback({});
        }
    }));
}
global_state_1.nyaoGlobal.config_dir_path = (0, path_1.join)(config_dir_name, 'nyaovim');
global_state_1.nyaoGlobal.nyaovimrc_path = (0, path_1.join)(global_state_1.nyaoGlobal.config_dir_path, 'nyaovimrc.html');
function loadCertificateFingerprints(bundlePath) {
    if (!bundlePath) {
        return new Set();
    }
    try {
        const pem = (0, fs_1.readFileSync)(bundlePath, 'utf8');
        const blocks = pem
            .split(/(?=-----BEGIN CERTIFICATE-----)/g)
            .map(block => block.trim())
            .filter(block => block.length > 0);
        const fingerprints = blocks.map(block => {
            const cert = new crypto_1.X509Certificate(block);
            return cert.fingerprint;
        });
        if (fingerprints.length === 0) {
            console.warn('[nyaovim] No certificates found in bundle:', bundlePath);
        }
        return new Set(fingerprints);
    }
    catch (err) {
        console.error('[nyaovim] Failed to load extra CA bundle', bundlePath, err);
        return new Set();
    }
}
const extraCaBundlePath = process.env.NODE_EXTRA_CA_CERTS || process.env.ELECTRON_EXTRA_CA_CERTS;
const extraCaFingerprints = loadCertificateFingerprints(extraCaBundlePath);
function splitPemBlocks(pem) {
    if (!pem) {
        return [];
    }
    const matches = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
    return matches ? matches : [];
}
function computeSpkiPin(source) {
    try {
        const cert = new crypto_1.X509Certificate(source);
        const spkiDer = cert.publicKey.export({ type: 'spki', format: 'der' });
        const digest = (0, crypto_1.createHash)('sha256').update(spkiDer).digest('base64');
        return `sha256/${digest}`;
    }
    catch (err) {
        console.error('[nyaovim] Failed to compute SPKI pin', err);
        return null;
    }
}
function loadSpkiPins(bundlePath) {
    if (!bundlePath || bundlePath.length === 0) {
        return new Set();
    }
    let pem;
    try {
        pem = (0, fs_1.existsSync)(bundlePath) ? (0, fs_1.readFileSync)(bundlePath, 'utf8') : bundlePath;
    }
    catch (err) {
        console.error('[nyaovim] Failed to read CA bundle for SPKI pins', bundlePath, err);
        return new Set();
    }
    const blocks = splitPemBlocks(pem);
    const pins = new Set();
    for (const block of blocks) {
        const pin = computeSpkiPin(block);
        if (pin) {
            pins.add(pin);
        }
    }
    return pins;
}
const extraCaSpkiPins = loadSpkiPins(extraCaBundlePath);
function collectFingerprints(certificate) {
    const fingerprints = [];
    const seen = new Set();
    let current = certificate;
    while (current) {
        const fp = current.fingerprint;
        if (fp && !seen.has(fp)) {
            fingerprints.push(fp);
            seen.add(fp);
        }
        current = current.issuerCert;
    }
    return fingerprints;
}
function configureCertificateVerify(targetSession) {
    if (extraCaSpkiPins.size === 0) {
        return;
    }
    targetSession.setCertificateVerifyProc((request, callback) => {
        var _a;
        if (request.verificationResult === 'net::OK') {
            callback(0);
            return;
        }
        const data = (_a = request.certificate) === null || _a === void 0 ? void 0 : _a.data;
        const pin = data ? computeSpkiPin(data) : null;
        if (pin && extraCaSpkiPins.has(pin)) {
            console.info('[nyaovim] Allowing certificate via SPKI pin for', request.hostname);
            callback(0);
            return;
        }
        if (pin) {
            console.debug('[nyaovim] SPKI pin mismatch', {
                hostname: request.hostname,
                pin,
            });
        }
        callback(-2);
    });
}
function exists(path) {
    return new Promise(resolve => {
        (0, fs_1.stat)(path, (err, stats) => {
            if (err) {
                resolve(false);
                return;
            }
            resolve(stats.isFile() || stats.isDirectory());
        });
    });
}
function prepareDefaultNyaovimrc() {
    console.log('Generate default nyaovimrc at ' + global_state_1.nyaoGlobal.nyaovimrc_path);
    return exists(global_state_1.nyaoGlobal.config_dir_path).then(e => {
        if (!e) {
            (0, mkdirp_1.sync)(global_state_1.nyaoGlobal.config_dir_path);
        }
    }).then(() => {
        const contents = `<dom-module id="nyaovim-app">
  <template>
    <style>
      /* CSS configurations here */
    </style>

    <!-- Component tags here -->
    <neovim-editor id="nyaovim-editor" argv="[[argv]]" font="monospace"></neovim-editor>
  </template>
</dom-module>
`;
        (0, fs_1.writeFileSync)(global_state_1.nyaoGlobal.nyaovimrc_path, contents, 'utf8');
    });
}
const ensure_nyaovimrc = exists(global_state_1.nyaoGlobal.nyaovimrc_path).then((e) => {
    if (!e) {
        return prepareDefaultNyaovimrc();
    }
    else {
        return undefined;
    }
}).catch(err => console.error(err));
const browser_config = new browser_config_1.default();
const prepare_browser_config = browser_config.loadFrom(global_state_1.nyaoGlobal.config_dir_path)
    .catch(err => console.error(err));
electron_1.ipcMain.on('nyaovim:get-global', (event, key) => {
    if (key === 'nyaovimrc_path') {
        event.returnValue = global_state_1.nyaoGlobal.nyaovimrc_path;
        return;
    }
    event.returnValue = undefined;
});
electron_1.ipcMain.on('nyaovim:get-process-argv', event => {
    event.returnValue = process.argv.slice();
});
electron_1.ipcMain.on('nyaovim:get-app-version', event => {
    event.returnValue = electron_1.app.getVersion();
});
electron_1.ipcMain.handle('nyaovim:set-represented-filename', (event, filePath) => {
    if (process.platform !== 'darwin' || !filePath) {
        return false;
    }
    const win = electron_1.BrowserWindow.fromWebContents(event.sender);
    if (win && typeof win.setRepresentedFilename === 'function') {
        win.setRepresentedFilename(filePath);
        return true;
    }
    return false;
});
electron_1.ipcMain.handle('nyaovim:add-recent-document', (_event, filePath) => {
    if (filePath && typeof electron_1.app.addRecentDocument === 'function') {
        electron_1.app.addRecentDocument(filePath);
    }
});
electron_1.ipcMain.handle('nyaovim:open-devtools', (event, mode) => {
    try {
        event.sender.openDevTools({ mode });
    }
    catch (err) {
        console.error('Failed to open devtools:', err);
    }
});
electron_1.ipcMain.handle('nyaovim:browser-window', (event, method, args = []) => {
    const win = electron_1.BrowserWindow.fromWebContents(event.sender);
    if (win && typeof win[method] === 'function') {
        return win[method](...(Array.isArray(args) ? args : []));
    }
    throw new Error(`Unsupported BrowserWindow method '${method}'`);
});
electron_1.ipcMain.handle('nyaovim:close-window', event => {
    const win = electron_1.BrowserWindow.fromWebContents(event.sender);
    if (win) {
        win.close();
    }
});
electron_1.ipcMain.on('neovim:get-node-env', event => {
    event.returnValue = process.env.NODE_ENV || 'production';
});
electron_1.ipcMain.on('nyaovim:renderer-ready', event => {
    rendererContents = event.sender;
    if (pendingOpenFiles.length > 0) {
        for (const file of pendingOpenFiles.splice(0, pendingOpenFiles.length)) {
            rendererContents.send('nyaovim:open-file', file);
        }
    }
});
electron_1.ipcMain.on('nyaovim:renderer-detached', event => {
    if (rendererContents === event.sender) {
        rendererContents = null;
    }
});
function startMainWindow() {
    const index_html = 'file://' + (0, path_1.join)(__dirname, '..', 'renderer', 'main.html');
    const default_config = {
        width: 800,
        height: 600,
        useContentSize: true,
        webPreferences: {
            contextIsolation: false,
            nodeIntegration: true,
            webviewTag: true,
        },
        icon: electron_1.nativeImage.createFromPath((0, path_1.join)(__dirname, '..', 'resources', 'icon', 'nyaovim-logo.png')),
    };
    const user_config = browser_config.applyToOptions(default_config);
    let win = new electron_1.BrowserWindow(user_config);
    const already_exists = browser_config.configSingletonWindow(win);
    if (already_exists) {
        electron_1.app.quit();
        return null;
    }
    browser_config.setupWindowState(win);
    if (browser_config.loaded_config !== null && browser_config.loaded_config.show_menubar === false) {
        win.setMenuBarVisibility(false);
    }
    const windowContents = win.webContents;
    win.once('closed', function () {
        if (rendererContents === windowContents) {
            rendererContents = null;
        }
        win = null;
    });
    win.loadURL(index_html);
    if (process.env.NODE_ENV !== 'production' && is_run_from_npm_package_on_darwin) {
        win.webContents.openDevTools({ mode: 'detach' });
    }
    return win;
}
electron_1.app.once('window-all-closed', () => electron_1.app.quit());
electron_1.app.on('open-url', (e, u) => {
    e.preventDefault();
    electron_1.shell.openExternal(u);
});
electron_1.app.once('will-finish-launching', function () {
    electron_1.app.once('open-file', (e, p) => {
        process.argv.push(p);
        if (!pendingOpenFiles.includes(p)) {
            pendingOpenFiles.push(p);
        }
        e.preventDefault();
    });
});
electron_1.app.on('open-file', (e, p) => {
    e.preventDefault();
    if (!pendingOpenFiles.includes(p)) {
        pendingOpenFiles.push(p);
    }
    if (appReady && rendererContents) {
        rendererContents.send('nyaovim:open-file', p);
        const index = pendingOpenFiles.indexOf(p);
        if (index !== -1) {
            pendingOpenFiles.splice(index, 1);
        }
    }
});
electron_1.app.once('ready', () => {
    appReady = true;
    const captureSession = electron_1.session.defaultSession;
    if (captureSession) {
        captureSession.setUserAgent(SPOOFED_USER_AGENT);
        configureCaptureSession(captureSession);
        configureCertificateVerify(captureSession);
    }
    electron_1.app.on('web-contents-created', (_event, contents) => {
        const targetSession = contents.session;
        if (targetSession) {
            try {
                targetSession.setUserAgent(SPOOFED_USER_AGENT);
            }
            catch (err) {
                console.warn('[nyaovim] Failed to set user agent for session', err);
            }
            configureCaptureSession(targetSession);
            configureCertificateVerify(targetSession);
        }
    });
    if (extraCaFingerprints.size > 0) {
        console.info('[nyaovim] Loaded extra CA fingerprints:', extraCaFingerprints.size);
        electron_1.app.on('certificate-error', (event, _webContents, _url, _error, certificate, callback) => {
            const fingerprints = collectFingerprints(certificate);
            const trusted = fingerprints.some(fp => extraCaFingerprints.has(fp));
            if (trusted) {
                event.preventDefault();
                callback(true);
                return;
            }
            callback(false);
        });
    }
    if (process.platform === 'darwin' && is_run_from_npm_package_on_darwin) {
        electron_1.app.dock.setIcon((0, path_1.join)(__dirname, '..', 'resources', 'icon', 'nyaovim-logo.png'));
    }
    if (typeof electron_1.app.configureHostResolver === 'function') {
        electron_1.app.configureHostResolver({ secureDnsMode: 'off' });
    }
    Promise.all([
        ensure_nyaovimrc,
        prepare_browser_config,
    ]).then(() => {
        const w = startMainWindow();
        if (w !== null) {
            (0, menu_1.default)(w);
        }
    });
});
//# sourceMappingURL=main.js.map