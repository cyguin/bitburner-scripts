export function getReservedAmount(ns) {
    try {
        const text = ns.read('reserve.txt');
        const val = parseFloat(text);
        return isNaN(val) ? 0 : val;
    } catch { return 0; }
}

export function instanceCount(ns, scriptName) {
    return ns.ps('home').filter(p => p.filename === scriptName).length;
}

export async function getActiveSourceFiles(ns) {
    try {
        const sf = {};
        const ri = ns.getResetInfo?.();
        if (ri?.ownedSF?.size) {
            for (const [bn, lvl] of ri.ownedSF) sf[bn] = lvl;
        }
        const player = ns.getPlayer();
        if (player.sourceFiles && Object.keys(sf).length === 0) {
            for (const [bn, lvl] of player.sourceFiles) sf[bn] = lvl;
        }
        return sf;
    } catch { return {}; }
}

export async function tryGetBitNodeMultipliers(ns) {
    try { return ns.getBitNodeMultipliers(); } catch { return null; }
}

export function getStocksValue(ns, player) {
    try {
        if (!player) player = ns.getPlayer();
        let total = 0;
        const syms = ns.getStockSymbols ? ns.getStockSymbols() : [];
        for (const sym of syms) {
            const pos = ns.getStockPosition ? ns.getStockPosition(sym) : [0, 0, 0, 0];
            const price = ns.getStockPrice ? ns.getStockPrice(sym) : 0;
            total += pos[0] * price + pos[2] * price;
        }
        return total;
    } catch { return 0; }
}

export function getConfiguration(ns, argsSchema, options = null) {
    if (options === null) {
        options = {};
        for (const [flag, defaultValue] of argsSchema)
            options[flag] = defaultValue;
    }
    let config = {};
    try {
        const configFile = ns.getScriptName() + '.config.txt';
        if (ns.ls('home', configFile).length > 0)
            config = JSON.parse(ns.read(configFile));
    } catch {}
    const flags = ns.flags(argsSchema.map(([f, d]) => typeof d === 'function' ? [f, null] : [f, d]));
    for (const [key, defaultValue] of argsSchema) {
        if (key in flags && flags[key] !== defaultValue && flags[key] !== null)
            options[key] = flags[key];
        else if (key in config && config[key] !== null)
            options[key] = config[key];
    }
    return options;
}

export function getFnRunViaNsRun(ns) { return ns.run; }
export function getFnRunViaNsExec(ns, host = "home") {
    return (scriptPath, ...args) => ns.exec(scriptPath, host, ...args);
}
export function getFnIsAliveViaNsIsRunning(ns) { return ns.isRunning; }
export function getFnIsAliveViaNsPs(ns) {
    return (pid, host) => ns.ps(host).some(p => p.pid === pid);
}

export function getScriptRam(ns, name, host = 'home') {
    try { return ns.getScriptRam(name, host) || Infinity; } catch { return Infinity; }
}

export function hasDarknetAccess(ns) {
    try {
        const ri = ns.getResetInfo?.();
        if (ri?.currentNode === 15) return true;
        if (ri?.ownedSF?.has?.(15)) return true;
        const player = ns.getPlayer();
        if (player.bitNodeN === 15) return true;
        const sourceFiles = player.sourceFiles || [];
        if (sourceFiles.some(([bn]) => bn === 15)) return true;
        if (ns.fileExists('DarkscapeNavigator.exe', 'home') || ns.fileExists('darkscape.exe', 'home')) return true;
    } catch {}
    return false;
}
