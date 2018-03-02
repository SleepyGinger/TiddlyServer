"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const server_types_1 = require("./server-types");
const rx_1 = require("../lib/rx");
const path = require("path");
const fs = require("fs");
const url_1 = require("url");
var settings = {};
const debug = server_types_1.DebugLogger('DAT');
const loadedFolders = {};
const otherSocketPaths = {};
function init(eventer) {
    eventer.on('settings', function (set) {
        settings = set;
    });
    eventer.on('websocket-connection', function (client, request) {
        let reqURL = url_1.parse(request.url); // new URL(request.url as string);
        let datafolder = loadedFolders[reqURL.pathname];
        debug([reqURL.pathname, !!datafolder].join(' '));
        if (!datafolder) {
            if (!otherSocketPaths[reqURL.pathname])
                otherSocketPaths[reqURL.pathname] = [];
            let other = otherSocketPaths[reqURL.pathname];
            other.push(client);
            client.addEventListener('message', event => {
                other.forEach(e => {
                    if (e === client)
                        return;
                    e.send(event.data);
                });
            });
            client.addEventListener('error', (event) => {
                debug('WS-ERROR %s %s', reqURL.pathname, event.type);
                other.splice(other.indexOf(client), 1);
                client.close();
            });
            client.addEventListener('close', (event) => {
                debug('WS-CLOSE %s %s %s', reqURL.pathname, event.code, event.reason);
                other.splice(other.indexOf(client), 1);
            });
            return;
        }
        datafolder.sockets.push(client);
        client.addEventListener('message', (event) => {
            // const message = new WebSocketMessageEvent(event, client);
            // (datafolder.$tw.wss as WebSocket);
            // datafolder.$tw.hooks.invokeHook('th-websocket-message', event.data, client);
        });
        client.addEventListener('error', (event) => {
            debug('WS-ERROR %s %s', reqURL.pathname, event.type);
            datafolder.sockets.splice(datafolder.sockets.indexOf(client), 1);
            client.close();
        });
        client.addEventListener('close', (event) => {
            debug('WS-CLOSE %s %s %s', reqURL.pathname, event.code, event.reason);
            datafolder.sockets.splice(datafolder.sockets.indexOf(client), 1);
        });
    });
}
exports.init = init;
function quickArrayCheck(obj) {
    return typeof obj.length === 'number';
}
function datafolder(result) {
    //warm the cache
    //require("tiddlywiki/boot/boot.js").TiddlyWiki();
    // Observable.of(result).mergeMap(res => {
    /**
     * reqpath  is the prefix for the folder in the folder tree
     * item     is the folder string in the category tree that reqpath led to
     * filepath is the path relative to them
     */
    let { state } = result;
    //get the actual path to the folder from filepath
    let filepathPrefix = result.filepathPortion.slice(0, state.statPath.index).join('/');
    //get the tree path, and add the file path (none if the tree path is a datafolder)
    let fullPrefix = ["", result.treepathPortion.join('/')];
    if (state.statPath.index > 0)
        fullPrefix.push(filepathPrefix);
    //join the parts and split into an array
    fullPrefix = fullPrefix.join('/').split('/');
    //use the unaltered path in the url as the tiddlywiki prefix
    let prefixURI = state.url.pathname.split('/').slice(0, fullPrefix.length).join('/');
    //get the full path to the folder as specified in the tree
    let folder = state.statPath.statpath;
    //initialize the tiddlywiki instance
    // reload the plugin cache if requested
    if (state.url.query.reload === "plugins")
        initPluginLoader();
    if (!loadedFolders[prefixURI] || state.url.query.reload === "true") {
        loadedFolders[prefixURI] = [];
        // loadTiddlyServerAdapter(prefixURI, folder, state.url.query.reload);
        loadTiddlyWiki(prefixURI, folder);
    }
    const isFullpath = result.filepathPortion.length === state.statPath.index;
    //set the trailing slash correctly if this is the actual page load
    //redirect ?reload=true requests to the same, to prevent it being 
    //reloaded multiple times for the same page load.
    if (isFullpath && !settings.useTW5path !== !state.url.pathname.endsWith("/")
        || state.url.query.reload) {
        let redirect = prefixURI + (settings.useTW5path ? "/" : "");
        state.res.writeHead(302, {
            'Location': redirect
        });
        state.res.end();
        return;
        // return Observable.empty();
    }
    //pretend to the handler like the path really has a trailing slash
    let req = new Object(state.req);
    req.url += ((isFullpath && !state.url.path.endsWith("/")) ? "/" : "");
    // console.log(req.url);
    const load = loadedFolders[prefixURI];
    if (Array.isArray(load)) {
        load.push(state);
    }
    else {
        load.handler(state);
    }
}
exports.datafolder = datafolder;
function loadTiddlyWiki(mount, folder) {
    console.time('twboot-' + folder);
    // const dynreq = "tiddlywiki";
    DataFolder(mount, folder, complete);
    function complete(err, $tw) {
        console.timeEnd('twboot-' + folder);
        if (err) {
            return doError(mount, folder, err);
        }
        //we use $tw.modules.execute so that the module has its respective $tw variable.
        var serverCommand;
        try {
            serverCommand = $tw.modules.execute('$:/core/modules/commands/server.js').Command;
        }
        catch (e) {
            doError(mount, folder, e);
            return;
        }
        var command = new serverCommand([], { wiki: $tw.wiki });
        var server = command.server;
        server.set({
            rootTiddler: "$:/core/save/all",
            renderType: "text/plain",
            serveType: "text/html",
            username: settings.username,
            password: "",
            pathprefix: mount
        });
        //websocket requests coming in here will need to be handled 
        //with $tw.hooks.invokeHook('th-websocket-message', event);
        const requests = loadedFolders[mount];
        const handler = (state) => server.requestHandler(state.req, state.res);
        loadedFolders[mount] = {
            mount,
            folder,
            handler,
            sockets: []
        };
        $tw.hooks.addHook('th-websocket-broadcast', function (message, ignore) {
            let folder = loadedFolders[mount];
            if (typeof message === 'object')
                message = JSON.stringify(message);
            else if (typeof message !== "string")
                message = message.toString();
            folder.sockets.forEach(client => {
                if (ignore.indexOf(client) > -1)
                    return;
                client.send(message);
            });
        });
        //send the requests to the handler
        requests.forEach(e => handler(e));
    }
}
;
function doError(mount, folder, err) {
    debug(3, 'error starting %s at %s: %s', mount, folder, err.stack);
    const requests = loadedFolders[mount];
    loadedFolders[mount] = {
        handler: function (state) {
            state.res.writeHead(500, "TW5 data folder failed");
            state.res.write("The Tiddlywiki data folder failed to load. The error has been logged to the " +
                "terminal with priority level 2. " +
                "To try again, use ?reload=true after making any necessary corrections.");
            state.res.end();
        }
    };
    requests.forEach(([req, res]) => {
        loadedFolders[mount].handler(req, res);
    });
}
function DataFolder(mount, folder, callback) {
    const $tw = require("../tiddlywiki/boot/boot.js").TiddlyWiki(require("../tiddlywiki/boot/bootprefix.js").bootprefix({
        packageInfo: JSON.parse(fs.readFileSync(path.join(__dirname, '../tiddlywiki/package.json'), 'utf8'))
    }));
    $tw.boot.argv = [folder];
    $tw.preloadTiddler({
        "text": "$protocol$//$host$" + mount + "/",
        "title": "$:/config/tiddlyweb/host"
    });
    /**
     * Specify the boot folder of the tiddlywiki instance to load. This is the actual path to the tiddlers that will be loaded
     * into wiki as tiddlers. Therefore this is the path that will be served to the browser. It will not actually run on the server
     * since we load the server files from here. We only need to make sure that we use boot.js from the same version as included in
     * the bundle.
    **/
    try {
        $tw.boot.boot(() => {
            callback(null, $tw);
        });
    }
    catch (err) {
        callback(err);
    }
}
let counter = 0;
const zlib_1 = require("zlib");
const boot_startup_1 = require("./boot-startup");
const fresh = require('../lib/fresh-lib');
let pluginCache;
let coreCache;
let bootCache;
let pluginLoader;
let global_tw;
function initPluginLoader() {
    pluginCache = {};
    const $tw = global_tw = boot_startup_1.loadCore();
    const pluginConfig = {
        plugins: [$tw.config.pluginsPath, $tw.config.pluginsEnvVar],
        themes: [$tw.config.themesPath, $tw.config.themesEnvVar],
        languages: [$tw.config.languagesPath, $tw.config.languagesEnvVar]
    };
    Object.keys(pluginConfig).forEach(type => {
        pluginCache[type] = {};
    });
    coreCache = {
        plugin: $tw.loadPluginFolder($tw.boot.corePath),
        cacheTime: new Date().valueOf()
    };
    // bootCache = {};
    // $tw.loadTiddlersFromPath($tw.boot.bootPath).forEach(tiddlerFile => {
    //     tiddlerFile.tiddlers.forEach(tiddlerFields => {
    //         bootCache[tiddlerFields.title] = tiddlerFields;
    //     })
    // });
    // $tw.loadTiddlersFromPath($tw.boot.bootPath) as { tiddlers: any[] }[];
    pluginLoader = function getPlugin(type, name) {
        if (!pluginCache[type][name]) {
            const typeInfo = pluginConfig[type];
            var paths = $tw.getLibraryItemSearchPaths(typeInfo[0], typeInfo[1]);
            let pluginPath = $tw.findLibraryItem(name, paths);
            let plugin = $tw.loadPluginFolder(pluginPath);
            if (!plugin)
                pluginCache[type][name] = "null";
            else
                pluginCache[type][name] = { plugin, cacheTime: new Date().valueOf() };
        }
        return pluginCache[type][name];
    };
    // return function (wikiInfo: WikiInfo) {
    //     return ['plugins', 'themes', 'languages'].map(type => {
    //         var pluginList = wikiInfo[type];
    //         if (!Array.isArray(pluginList)) return [] as never;
    //         else return pluginList.map(name => getPlugin(type, name));
    //     }).reduce((n, e) => n.concat(e), [] as PluginCache[]);
    // }
}
initPluginLoader();
// mounted at /tiddlywiki
const serveBootFolder = new rx_1.Subject();
server_types_1.serveFolder(serveBootFolder.asObservable(), '/tiddlywiki/boot', path.join(__dirname, "../tiddlywiki/boot"), server_types_1.serveFolderIndex({ type: 'json' }));
function doTiddlyWikiRoute(input) {
    return input.do(state => {
        if (['plugins', 'themes', 'languages', 'core', 'boot'].indexOf(state.path[2]) === -1) {
            state.throw(404);
        }
        else if (state.path[2] === "core") {
            sendPluginResponse(state, coreCache);
        }
        else if (state.path[2] === "boot") {
            serveBootFolder.next(state);
        }
        else {
            sendPluginResponse(state, pluginLoader(state.path[2], decodeURIComponent(state.path[3])));
        }
    }).ignoreElements();
}
exports.doTiddlyWikiRoute = doTiddlyWikiRoute;
function sendPluginResponse(state, pluginCache) {
    const { req, res } = state;
    if (pluginCache === "null") {
        res.writeHead(404);
        res.end();
        return;
    }
    let text = pluginCache.plugin.text;
    delete pluginCache.plugin.text;
    let meta = JSON.stringify(pluginCache.plugin);
    const body = meta + '\n\n' + text;
    var MAX_MAXAGE = 60 * 60 * 24 * 365 * 1000; //1 year
    var maxAge = Math.min(Math.max(0, settings.maxAge.tw_plugins), MAX_MAXAGE);
    var cacheControl = 'public, max-age=' + Math.floor(settings.maxAge.tw_plugins / 1000);
    debug(-3, 'cache-control %s', cacheControl);
    res.setHeader('Cache-Control', cacheControl);
    var modified = new Date(pluginCache.cacheTime).toUTCString();
    debug(-3, 'modified %s', modified);
    res.setHeader('Last-Modified', modified);
    var etag = etag(body);
    debug(-3, 'etag %s', etag);
    res.setHeader('ETag', etag);
    if (fresh(req.headers, { 'etag': etag, 'last-modified': modified })) {
        res.writeHead(304);
        res.end();
    }
    else {
        sendResponse(res, body, { doGzip: acceptGzip(req) });
    }
}
function loadTiddlyServerAdapter(mount, folder, reload) {
    let cacheRequests = [];
    let cachePrepared = (settings.tsa.alwaysRefreshCache || reload === "tsacache")
        ? false : fs.existsSync(path.join(folder, 'cache'));
    const { $tw, wikiInfo } = boot_startup_1.loadWiki(folder);
    const { files } = $tw.boot;
    if (!wikiInfo)
        return doError(mount, folder, new Error("WikiInfo not loaded"));
    initTiddlyServerAdapterCache(mount, folder).then(() => {
        cachePrepared = true;
        cacheRequests.forEach((state) => sendCacheFolder.next(state));
        cacheRequests = [];
    });
    const sendCacheFolder = new rx_1.Subject();
    server_types_1.serveFolder(sendCacheFolder.asObservable(), mount + "/cache", folder + "/cache");
    function handler(state) {
        const { req, res } = state;
        // const state = new TiddlyServerAdapterStateObject(folder, mount, req, res, wikiInfo, files);
        const tsa = new TSASO(state, wikiInfo, folder, mount, files);
        // GET the mount, which has no trailing slash
        if (!tsa.localPath.length) {
            if (req.method === "GET")
                sendLoader(tsa);
            else {
                res.writeHead(405);
                res.end();
            }
        }
        else if (tsa.localPathParts[1] === "tiddlers.json") {
            // GET /tiddlers.json
            if (req.method === "GET")
                sendTiddlers(tsa);
            else {
                res.writeHead(405);
                res.end();
            }
        }
        else if (tsa.localPathParts[1] === "tiddlers") {
            // ALL /tiddlers/*
            handleTiddlersRoute(tsa);
        }
        else if (tsa.localPathParts[1] === "cache") {
            // ALL /cache/*
            if (['GET', 'HEAD'].indexOf(req.method) > -1) {
                if (!cachePrepared)
                    cacheRequests.push(state);
                else
                    sendCacheFolder.next(state);
            }
            else if (['PUT', 'DELETE'].indexOf(req.method) > -1) {
                handleCacheRoute(tsa);
            }
            else if (req.method === "OPTIONS") {
                state.res.writeHead(200);
                state.res.write("GET,HEAD,PUT,DELETE,OPTIONS");
                state.res.end();
            }
            else {
                res.writeHead(405);
                res.end();
            }
        }
        else {
            res.writeHead(404);
            res.end();
        }
    }
    const requests = loadedFolders[mount];
    loadedFolders[mount] = { handler, folder, mount, sockets: [] };
    requests.forEach((state) => handler(state));
}
function initTiddlyServerAdapterCache(mount, folder) {
    return new Promise(resolve => DataFolder(mount, folder, (err, $tw) => {
        //render the different caches here and save them to disk
    }));
}
class TSASO {
    constructor(state, wikiInfo, folder, mount, 
        /** Hashmap keyed to tiddler title */
        files) {
        this.state = state;
        this.wikiInfo = wikiInfo;
        this.folder = folder;
        this.mount = mount;
        this.files = files;
        this.localPath = state.url.pathname.slice(mount.length);
        this.localPathParts = this.localPath.split('/');
    }
}
const globalRegex = /\$\{mount\}/g;
//just save it here so we don't have to keep reloading it
const loaderText = fs.readFileSync(path.join(__dirname, './datafolder-template.html'), 'utf8');
function sendLoader(tsa) {
    sendResponse(tsa.state.res, loaderText.replace(globalRegex, tsa.mount), { doGzip: acceptGzip(tsa.state.req), contentType: "text/html; charset=utf-8" });
}
function sendTiddlers(tsa) {
    const { $tw, wikiInfo } = boot_startup_1.loadWiki(tsa.folder);
    const tiddlers = [];
    $tw.wiki.each((tiddler, title) => {
        tiddlers.push(tiddler.fields);
    });
    let text = JSON.stringify(tiddlers);
    var cacheControl = 'no-cache';
    debug(-3, 'cache-control %s', cacheControl);
    tsa.state.res.setHeader('Cache-Control', cacheControl);
    var etag = etag(text);
    debug(-3, 'etag %s', etag);
    tsa.state.res.setHeader('ETag', etag);
    sendResponse(tsa.state.res, text, { doGzip: acceptGzip(tsa.state.req), contentType: "application/json; charset=utf-8" });
}
const newLineBuffer = Buffer.from('\n');
function handleTiddlersRoute(tsa) {
    //GET HEAD PUT DELETE
    let title = decodeURIComponent(tsa.localPathParts[2]);
    let fileinfo = tsa.files[title];
    // let tiddlers = global_tw.loadTiddlersFromFile(fileinfo.filepath);
    let { filepath } = fileinfo;
    if (tsa.state.req.method === "GET") {
        var ext = path.extname(filepath), extensionInfo = global_tw.utils.getFileExtensionInfo(ext), type = extensionInfo ? extensionInfo.type : null, typeInfo = type ? global_tw.config.contentTypeInfo[type] : null;
        server_types_1.obs_readFile()(filepath, typeInfo ? typeInfo.encoding : "utf8").concatMap(([err, data]) => {
            var tiddlers = global_tw.wiki.deserializeTiddlers(ext, data, {});
            if (ext !== ".json" && tiddlers.length === 1)
                return server_types_1.obs_readFile(tiddlers)(filepath + ".meta", 'utf8');
            else
                return rx_1.Observable.of([undefined, undefined, tiddlers]);
        }).map(([err, data, tiddlers]) => {
            let metadata = data ? global_tw.utils.parseFields(data) : {};
            tiddlers = global_tw.utils.extend({}, tiddlers[0], metadata);
            return tiddlers[0];
        }).subscribe(tiddlers => {
            if (tiddlers.length !== 1) {
                //we don't serve anything not in the files list here
                tsa.state.throw(404);
            }
            else {
                let tiddler = tiddlers[0];
                let { res } = tsa.state;
                let text = Buffer.from(tiddler.text, typeInfo.encoding);
                delete tiddler.text;
                //use utf16 so we can convert straight back to a string in the browser
                let header = Buffer.from(JSON.stringify(tiddler), 'utf8');
                let body = Buffer.concat([
                    header,
                    newLineBuffer,
                    Buffer.from(typeInfo ? typeInfo.encoding : "utf8", 'binary'),
                    newLineBuffer,
                    text
                ]);
                sendResponse(res, body, {
                    doGzip: acceptGzip(tsa.state.req),
                    contentType: "application/octet-stream"
                });
            }
        });
    }
    return ((tsa.state.req.method === "PUT")
        ? tsa.state.recieveBody().mapTo(tsa)
        : rx_1.Observable.of(tsa)).map(tsa => {
    });
}
function handleCacheRoute(tsa) {
    //stores library and rawmarkup code sections as the full javascript to be returned
    //the source tiddlers are sent separately to allow editing later. Only the javascript
    //is stored in the cache. If we do not have a cache, we temporarily load the entire
    //folder during the mount sequence to generate it. 
    //PUT DELETE
}
function acceptGzip(header) {
    if (((a) => typeof a === "object")(header)) {
        header = header.headers['accept-encoding'];
    }
    var gzip = header.split(',').map(e => e.split(';')).filter(e => e[0] === "gzip")[0];
    return !!gzip && !!gzip[1] && parseFloat(gzip[1].split('=')[1]) > 0;
}
function sendResponse(res, body, options = {}) {
    body = !Buffer.isBuffer(body) ? Buffer.from(body, 'utf8') : body;
    if (options.doGzip)
        zlib_1.gzip(body, (err, gzBody) => {
            if (err)
                _send(body, false);
            else
                _send(gzBody, true);
        });
    else
        _send(body, false);
    function _send(body, isGzip) {
        res.setHeader('Content-Length', Buffer.isBuffer(body)
            ? body.length.toString()
            : Buffer.byteLength(body, 'utf8').toString());
        if (isGzip)
            res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Type', options.contentType || 'text/plain; charset=utf-8');
        res.writeHead(200);
        res.write(body);
        res.end();
    }
}
