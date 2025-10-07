function! nyaovim#load_nyaovim_plugin(runtimepath) abort
    call rpcnotify(0, 'nyaovim:load-plugin-dir', a:runtimepath)
endfunction

function! nyaovim#load_nyaovim_plugin_direct(html_path) abort
    if a:html_path !~# '\.html$'
        throw 'nyaovim: Invalid file name.  HTML file is expected.'
    endif
    call rpcnotify(0, 'nyaovim:load-path', a:html_path)
endfunction

function! nyaovim#require_javascript_file(script_path) abort
    if !filereadable(a:script_path)
        throw 'nyaovim: Specified JavaScript code doesn''t exist: ' . a:script_path
    endif
    call rpcnotify(0, 'nyaovim:require-script-file', a:script_path);
endfunction

function! nyaovim#call_javascript_function(func_name, args) abort
    call rpcnotify(0, 'nyaovim:call-global-function', a:func_name, a:args)
endfunction

function! nyaovim#open_devtools(...) abort
    let mode = a:0 > 0 ? a:1 : 'detach'
    if index(['right', 'bottom', 'undocked', 'detach'], mode) == -1
        throw "nyaovim: Invalid mode '" . mode . "' for DevTools.  Mode must be one of 'right', 'bottom', 'undocked' or 'detach'"
    endif
    call rpcnotify(0, 'nyaovim:open-devtools', mode)
endfunction

" TODO:
" This function should return the result of JavaScript code using request
" instead of notification.
function! nyaovim#execute_javascript(code) abort
    call rpcnotify(0, 'nyaovim:execute-javascript', a:code)
endfunction

" TODO: Send request and get the return value
function! nyaovim#browser_window(method, args) abort
    call rpcnotify(0, 'nyaovim:browser-window', a:method, a:args)
endfunction

function! nyaovim#clipboard_copy(lines, regtype) abort
    let l:channel = get(g:, 'nyaovim_clipboard_channel', 0)
    if l:channel > 0
        call rpcnotify(l:channel, 'nyaovim-clipboard-put', a:lines, a:regtype)
    endif
endfunction

function! nyaovim#clipboard_paste() abort
    let l:channel = get(g:, 'nyaovim_clipboard_channel', 0)
    if l:channel > 0
        return rpcrequest(l:channel, 'nyaovim-clipboard-get')
    endif
    return [[], '']
endfunction

function! nyaovim#setup_clipboard() abort
    let l:channel = get(g:, 'nyaovim_clipboard_channel', 0)
    if l:channel <= 0
        return
    endif

    if exists('g:clipboard') && has_key(g:clipboard, 'name') && g:clipboard.name ==# 'nyaovim-electron'
        return
    endif

    let g:clipboard = {
          \ 'name': 'nyaovim-electron',
          \ 'copy': {
          \   '+': function('nyaovim#clipboard_copy'),
          \   '*': function('nyaovim#clipboard_copy'),
          \ },
          \ 'paste': {
          \   '+': function('nyaovim#clipboard_paste'),
          \   '*': function('nyaovim#clipboard_paste'),
          \ },
          \ 'cache_enabled': 0,
          \ }
endfunction
