if (process.platform !== 'win32') {
    const lifeSupport = ['/usr/local/bin', '/opt/homebrew/bin'];
    const currentPath = process.env.PATH || '';
    const additions = lifeSupport.filter(p => currentPath.indexOf(p) === -1);

    if (additions.length !== 0) {
        const separator = currentPath.length === 0 ? '' : ':';
        process.env.PATH = currentPath + separator + additions.join(':');
    }
}

// Note:
// Using a require() keeps us aligned with how Electron bundles renderer scripts loaded via
// <script> tags. Emitting an import statement would duplicate the module variable and blow up
// at runtime when both main.js and nyaovim-app.js execute.

/* tslint:disable:no-var-requires */
const {ipcRenderer} = require('electron');
const nyaovimrc_path: string | undefined = ipcRenderer.sendSync('nyaovim:get-global', 'nyaovimrc_path');
/* tslint:enable:no-var-requires */

if (!nyaovimrc_path) {
    console.error('nyaovimrc is not found in renderer process');
}

const link: HTMLLinkElement = document.createElement('link');
link.rel = 'import';
link.href = nyaovimrc_path;
document.head.appendChild(link);
