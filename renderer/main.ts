if (process.env.PATH.indexOf('/usr/local/bin') === -1 && process.platform !== 'win32') {
    // Note:
    // This solves the problem that $PATH is not set up when app is
    // started via clicking NyaoVim.app.
    //
    // XXX:
    // This is just a workaround.
    // If nvim is installed to other directory, we can't know that.
    process.env.PATH += ':/usr/local/bin';
}

// Note:
// Using a require() keeps us aligned with how Electron bundles renderer scripts loaded via
// <script> tags. Emitting an import statement would duplicate the module variable and blow up
// at runtime when both main.js and nyaovim-app.js execute.

/* tslint:disable:no-var-requires */
const electronRemote = require('@electron/remote');
const nyaovimrc_path: string = electronRemote.getGlobal('nyaovimrc_path');
/* tslint:enable:no-var-requires */

if (!nyaovimrc_path) {
    console.error('nyaovimrc is not found in renderer process');
}

const link: HTMLLinkElement = document.createElement('link');
link.rel = 'import';
link.href = nyaovimrc_path;
document.head.appendChild(link);
