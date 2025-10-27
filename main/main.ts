import {join} from 'path';
import {stat, writeFileSync, readFileSync} from 'fs';
import {app, BrowserWindow, shell, nativeImage, ipcMain, session, desktopCapturer} from 'electron';
import {X509Certificate} from 'crypto';
import {sync as mkdirpSync} from 'mkdirp';
import setMenu from './menu';
import BrowserConfig from './browser-config';
import {nyaoGlobal} from './global-state';
import type {BrowserWindowConstructorOptions, WebContents, Certificate, Session} from 'electron';

const GPU_SWITCHES: Array<[string, string | undefined]> = [
    ['enable-gpu-rasterization', undefined],
    ['enable-zero-copy', undefined],
    ['enable-oop-rasterization', undefined],
    ['enable-accelerated-2d-canvas', undefined],
    ['enable-features', 'CanvasOopRasterization,Canvas2DLayers,UseSkiaRenderer'],
    ['disable-features', 'PostQuantumKyber,PostQuantumKyberWithoutPqkeyMaterial'],
];
GPU_SWITCHES.forEach(([name, value]) => {
    if (value !== undefined) {
        app.commandLine.appendSwitch(name, value);
    } else {
        app.commandLine.appendSwitch(name);
    }
});

const SPOOFED_USER_AGENT =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.240 Safari/537.36';

app.userAgentFallback = SPOOFED_USER_AGENT;

if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = app.isPackaged ? 'production' : 'development';
}

if (process.argv.indexOf('--help') !== -1) {
    console.log(`OVERVIEW: NyaoVim; Web-enhanced Extensible Neovim Frontend

USAGE: nyaovim [options] [neovim args...]

OPTIONS:
  --no-detach : Don't detach the editor process
  --help      : Show this help
  --version   : Show versions of NyaoVim, Electron, Chrome, Node.js, and V8
`);
    app.exit();
}

if (process.argv.indexOf('--version') !== -1) {
    const vs: {[n: string]: string} = process.versions as any;
    const versions = ['electron', 'chrome', 'node', 'v8'].map((n: string) => `  ${n} : ${vs[n]}`).join('\n');
    console.log(`${app.getName()} version ${app.getVersion()}
${versions}
`);
    app.exit();
}

process.on('unhandledRejection', (reason: string, p: Promise<any>) => {
    console.error('Fatal: Unhandled rejection at: Promise', p, 'Reason:', reason);
});

const is_run_from_npm_package_on_darwin =
    app.getAppPath().indexOf('/NyaoVim.app/') === -1;

const config_dir_name =
        process.platform !== 'darwin' ?
            app.getPath('appData') :
            process.env.XDG_CONFIG_HOME || join(process.env.HOME, '.config');

const pendingOpenFiles: string[] = [];
let rendererContents: WebContents | null = null;
let appReady = false;

const configuredCaptureSessions = new WeakSet<Session>();

type MediaPermissionDetails = {
    mediaTypes?: Array<'video' | 'audio'>;
    requestingUrl?: string;
    securityOrigin?: string;
};

function configureCaptureSession(targetSession: Session) {
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
            const mediaDetails =
                details && typeof details === 'object' ?
                    details as MediaPermissionDetails :
                    undefined;
            const mediaTypes = Array.isArray(mediaDetails?.mediaTypes) ? mediaDetails?.mediaTypes : [];
            if (mediaTypes.length === 0) {
                console.info('[nyaovim] Allowing media request with unspecified types');
                callback(true);
                return;
            }
            const allowsCapture = mediaTypes.some(type => type === 'video' || type === 'audio');
            if (allowsCapture) {
                console.info('[nyaovim] Allowing media request', {mediaTypes});
                callback(true);
                return;
            }
        }
        callback(false);
    });
    targetSession.setDisplayMediaRequestHandler(async (request, callback) => {
        console.info('[nyaovim] Display media request', {
            audioRequested: request.audioRequested,
            videoRequested: request.videoRequested,
            userGesture: request.userGesture,
        });
        try {
            const sources = await desktopCapturer.getSources({types: ['screen', 'window']});
            console.info('[nyaovim] Available display media sources', sources.map(source => ({
                id: source.id,
                name: source.name,
            })));
            const preferredSource =
                sources.find(source => source.id.startsWith('screen:')) || sources[0];
            if (!preferredSource) {
                console.warn('[nyaovim] No display media sources available');
                callback({});
                return;
            }
            callback({
                video: {id: preferredSource.id, name: preferredSource.name},
                audio: request.audioRequested ? 'loopback' : undefined,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[nyaovim] Failed to fulfill display media request:', message);
            callback({});
        }
    });
}

nyaoGlobal.config_dir_path = join(config_dir_name, 'nyaovim');
nyaoGlobal.nyaovimrc_path = join(nyaoGlobal.config_dir_path, 'nyaovimrc.html');

function loadCertificateFingerprints(bundlePath: string | undefined): Set<string> {
    if (!bundlePath) {
        return new Set();
    }
    try {
        const pem = readFileSync(bundlePath, 'utf8');
        const blocks = pem
            .split(/(?=-----BEGIN CERTIFICATE-----)/g)
            .map(block => block.trim())
            .filter(block => block.length > 0);
        const fingerprints = blocks.map(block => {
            const cert = new X509Certificate(block);
            return cert.fingerprint;
        });
        if (fingerprints.length === 0) {
            console.warn('[nyaovim] No certificates found in bundle:', bundlePath);
        }
        return new Set(fingerprints);
    } catch (err) {
        console.error('[nyaovim] Failed to load extra CA bundle', bundlePath, err);
        return new Set();
    }
}

const extraCaBundlePath = process.env.NODE_EXTRA_CA_CERTS || process.env.ELECTRON_EXTRA_CA_CERTS;
const extraCaFingerprints = loadCertificateFingerprints(extraCaBundlePath);

function collectFingerprints(certificate: Certificate | null | undefined): string[] {
    const fingerprints: string[] = [];
    const seen = new Set<string>();
    let current: Certificate | null | undefined = certificate;
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

function exists(path: string) {
    return new Promise<boolean>(resolve => {
        stat(path, (err, stats) => {
            if (err) {
                resolve(false);
                return;
            }
            resolve(stats.isFile() || stats.isDirectory());
        });
    });
}

function prepareDefaultNyaovimrc() {
    console.log('Generate default nyaovimrc at ' + nyaoGlobal.nyaovimrc_path);

    return exists(nyaoGlobal.config_dir_path).then(e => {
        if (!e) {
            mkdirpSync(nyaoGlobal.config_dir_path);
        }
    }).then(() => {
        const contents =
`<dom-module id="nyaovim-app">
  <template>
    <style>
      /* CSS configurations here */
    </style>

    <!-- Component tags here -->
    <neovim-editor id="nyaovim-editor" argv="[[argv]]" font="monospace"></neovim-editor>
  </template>
</dom-module>
`;
        writeFileSync(nyaoGlobal.nyaovimrc_path, contents, 'utf8');
    });
}

const ensure_nyaovimrc = exists(nyaoGlobal.nyaovimrc_path).then((e: boolean) => {
    if (!e) {
        return prepareDefaultNyaovimrc();
    } else {
        // Note: This line needs because of TS7030 error
        return undefined;
    }
}).catch(err => console.error(err));

const browser_config = new BrowserConfig();
const prepare_browser_config
    = browser_config.loadFrom(nyaoGlobal.config_dir_path)
        .catch(err => console.error(err));

ipcMain.on('nyaovim:get-global', (event, key: string) => {
    if (key === 'nyaovimrc_path') {
        event.returnValue = nyaoGlobal.nyaovimrc_path;
        return;
    }
    event.returnValue = undefined;
});

ipcMain.on('nyaovim:get-process-argv', event => {
    event.returnValue = process.argv.slice();
});

ipcMain.on('nyaovim:get-app-version', event => {
    event.returnValue = app.getVersion();
});

ipcMain.handle('nyaovim:set-represented-filename', (event, filePath: string) => {
    if (process.platform !== 'darwin' || !filePath) {
        return false;
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && typeof win.setRepresentedFilename === 'function') {
        win.setRepresentedFilename(filePath);
        return true;
    }
    return false;
});

ipcMain.handle('nyaovim:add-recent-document', (_event, filePath: string) => {
    if (filePath && typeof app.addRecentDocument === 'function') {
        app.addRecentDocument(filePath);
    }
});

ipcMain.handle('nyaovim:open-devtools', (event, mode: Electron.OpenDevToolsOptions['mode']) => {
    try {
        event.sender.openDevTools({mode});
    } catch (err) {
        console.error('Failed to open devtools:', err);
    }
});

ipcMain.handle('nyaovim:browser-window', (event, method: string, args: unknown[] = []) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && typeof (win as any)[method] === 'function') {
        return (win as any)[method](...(Array.isArray(args) ? args : []));
    }
    throw new Error(`Unsupported BrowserWindow method '${method}'`);
});

ipcMain.handle('nyaovim:close-window', event => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
        win.close();
    }
});

ipcMain.on('neovim:get-node-env', event => {
    event.returnValue = process.env.NODE_ENV || 'production';
});

ipcMain.on('nyaovim:renderer-ready', event => {
    rendererContents = event.sender;
    if (pendingOpenFiles.length > 0) {
        for (const file of pendingOpenFiles.splice(0, pendingOpenFiles.length)) {
            rendererContents.send('nyaovim:open-file', file);
        }
    }
});

ipcMain.on('nyaovim:renderer-detached', event => {
    if (rendererContents === event.sender) {
        rendererContents = null;
    }
});

function startMainWindow() {
    const index_html = 'file://' + join(__dirname, '..', 'renderer', 'main.html');

    const default_config: BrowserWindowConstructorOptions = {
        width: 800,
        height: 600,
        useContentSize: true,
        webPreferences: {
            contextIsolation: false,
            nodeIntegration: true,
            webviewTag: true,
        },
        icon: nativeImage.createFromPath(join(__dirname, '..', 'resources', 'icon', 'nyaovim-logo.png')),
    };

    const user_config = browser_config.applyToOptions(default_config);

    let win = new BrowserWindow(user_config);

    const already_exists = browser_config.configSingletonWindow(win);
    if (already_exists) {
        app.quit();
        return null;
    }

    browser_config.setupWindowState(win);
    if (browser_config.loaded_config !== null && browser_config.loaded_config.show_menubar === false) {
        win.setMenuBarVisibility(false);
    }

    const windowContents = win.webContents;
    win.once('closed', function() {
        if (rendererContents === windowContents) {
            rendererContents = null;
        }
        win = null;
    });

    win.loadURL(index_html);
    if (process.env.NODE_ENV !== 'production' && is_run_from_npm_package_on_darwin) {
        win.webContents.openDevTools({mode: 'detach'});
    }

    return win;
}

app.once('window-all-closed', () => app.quit());
app.on('open-url', (e: Event, u: string) => {
    e.preventDefault();
    shell.openExternal(u);
});
app.once('will-finish-launching', function() {
    // we use once here because only the first open-file event might be missed by nyaovim-app
    app.once('open-file', (e: Event, p: string) => {
        // open-file event might be sent before ready event is emitted
        // put it in argv to let nyaovim-app to pick it up later
        process.argv.push(p);
        if (!pendingOpenFiles.includes(p)) {
            pendingOpenFiles.push(p);
        }
        e.preventDefault();
    });
});

app.on('open-file', (e: Event, p: string) => {
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

app.once(
    'ready',
    () => {
        appReady = true;
        const captureSession = session.defaultSession;
        if (captureSession) {
            captureSession.setUserAgent(SPOOFED_USER_AGENT);
            configureCaptureSession(captureSession);
            if (extraCaFingerprints.size > 0) {
                captureSession.setCertificateVerifyProc((request, callback) => {
                    const withVerified = request as typeof request & {verifiedCertificate?: Certificate};
                    const source = withVerified.verifiedCertificate || request.certificate;
                    const chain = collectFingerprints(source);
                    const trusted = chain.some(fp => extraCaFingerprints.has(fp));
                    if (trusted) {
                        console.info('[nyaovim] Allowing certificate via extra CA bundle for', request.hostname);
                        callback(0);
                        return;
                    }
                    callback(-2);
                });
            }
        }
        app.on('web-contents-created', (_event, contents) => {
            const targetSession = contents.session;
            if (targetSession) {
                try {
                    targetSession.setUserAgent(SPOOFED_USER_AGENT);
                } catch (err) {
                    console.warn('[nyaovim] Failed to set user agent for session', err);
                }
                configureCaptureSession(targetSession);
                if (extraCaFingerprints.size > 0) {
                    targetSession.setCertificateVerifyProc((request, callback) => {
                        const withVerified = request as typeof request & {verifiedCertificate?: Certificate};
                        const source = withVerified.verifiedCertificate || request.certificate;
                        const chain = collectFingerprints(source);
                        const trusted = chain.some(fp => extraCaFingerprints.has(fp));
                        if (trusted) {
                            console.info('[nyaovim] Allowing certificate via extra CA bundle for', request.hostname);
                            callback(0);
                            return;
                        }
                        callback(-2);
                    });
                }
            }
        });
        if (extraCaFingerprints.size > 0) {
            console.info('[nyaovim] Loaded extra CA fingerprints:', extraCaFingerprints.size);
            app.on('certificate-error', (event, _webContents, _url, _error, certificate, callback) => {
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
            // XXX:
            // app.dock.setIcon() is not defined in github-electron.d.ts yet.
            (app.dock as any).setIcon(join(__dirname, '..', 'resources', 'icon', 'nyaovim-logo.png'));
        }

        if (typeof (app as any).configureHostResolver === 'function') {
            (app as any).configureHostResolver({secureDnsMode: 'off'});
        }

        Promise.all([
            ensure_nyaovimrc,
            prepare_browser_config,
        ]).then(() => {
            const w = startMainWindow();
            if (w !== null) {
                setMenu(w);
            }
        });
    },
);
