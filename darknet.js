import { getConfiguration, log, getErrorInfo } from './helpers.js'
import { getCandidates } from './crackers.js'

const argsSchema = [
    ['reserve', null],
    ['autopilot', false],
    ['interval', 10000],
    ['phishing-interval', 60000],
    ['cache-auto-open', true],
    ['stock-promotion', true],
    ['migrate-target-depth', 20],
    ['migrate-auto', true],
    ['induce-migration', true],
    ['memory-reallocation', true],
    ['labyrinth-auto', true],
    ['tail', false],
    ['no-stock-promotion', false],
    ['password-cache-file', '/data/dnet-passwords.json'],
    ['max-auth-retries', 60],
];

export function autocomplete(data, args) { data.flags(argsSchema); return []; }

    const opts = getConfiguration(ns, argsSchema);
    // Darknet access gated by autopilot (SF15 or BN15)
    if (!ns.darknet) {
        return;
    }

    log(ns, `darknet.js starting`);

    const HOME = 'home';
    let knownServers = {}; // hostname -> { password, depth, modelId, session, lastSeen }
    let maxDepthReached = 0;

    function loadPasswordCache() {
        try {
            ns.scp(opts['password-cache-file'], ns.getHostname(), HOME);
        } catch {}
        try {
            const raw = ns.read(opts['password-cache-file']);
            if (raw) {
                const parsed = JSON.parse(raw);
                for (const [host, pw] of Object.entries(parsed)) {
                    if (typeof pw === 'string') {
                        knownServers[host] = knownServers[host] || {};
                        knownServers[host].password = pw;
                    } else if (typeof pw === 'object' && pw?.password) {
                        knownServers[host] = { ...knownServers[host], ...pw };
                    }
                }
            }
        } catch { knownServers = {}; }
    }

    function savePasswordCache() {
        const pwFile = opts['password-cache-file'];
        const flat = {};
        for (const [host, info] of Object.entries(knownServers)) {
            if (info?.password) flat[host] = info.password;
        }
        try { ns.write(pwFile, JSON.stringify(flat), 'w'); } catch {}
        try { ns.scp(pwFile, HOME); } catch {}
    }

    loadPasswordCache();

    while (true) {
        try {
            await tick(ns, opts, reserve);
        } catch (e) {
            log(ns, `Error: ${getErrorInfo(e)}`);
        }
        await ns.sleep(opts.interval);
    }
}

async function tick(ns, opts, reserve) {
    const dnet = ns.dnet;
    let server = ns.getHostname();

    if (!dnet.isDarknetServer(server)) {
        if (opts.autopilot && !ns.isRunning('autopilot.js')) ns.run('autopilot.js');
        const entry = dnet.probe().find(h => dnet.isDarknetServer(h));
        if (entry) { try { ns.singularity.connect(entry); } catch {} }
        return;
    }

    let details;
    try { details = dnet.getServerDetails(); } catch { return; }
    const depth = dnet.getDepth(server);
    if (depth > 0) maxDepthReached = Math.max(maxDepthReached, depth);

    if (details.blockedRam > 0 && opts['memory-reallocation']) {
        try {
            const result = await dnet.memoryReallocation(server);
            if (result.success) log(ns, `Freed RAM on ${server}`);
        } catch (e) { log(ns, `memRealloc: ${getErrorInfo(e)}`); }
    }

    if (opts['cache-auto-open']) {
        const files = ns.ls(server).filter(f => f.endsWith('.cache'));
        for (const cf of files) {
            try {
                const result = await dnet.openCache(cf, true);
                log(ns, `Cache ${cf}: ${result.message}`);
            } catch {}
        }
    }

    if (opts['stock-promotion'] && !opts['no-stock-promotion']) {
        await promoteStocksOnServer(ns, dnet);
    }

    const neighbors = dnet.probe(false);
    for (const neighbor of neighbors) {
        if (!knownServers[neighbor]) {
            knownServers[neighbor] = { lastSeen: Date.now() };
        }
        knownServers[neighbor].lastSeen = Date.now();

        const nDetails = dnet.getServerDetails(neighbor);
        const nDepth = dnet.getDepth(neighbor);
        knownServers[neighbor].depth = nDepth;
        knownServers[neighbor].modelId = nDetails.modelId;
        knownServers[neighbor].isOnline = nDetails.isOnline;

        if (nDetails.isOnline && nDetails.isConnectedToCurrentServer && !nDetails.hasSession) {
            await tryAuth(ns, dnet, neighbor, nDetails, opts);
        }

        if (nDetails.isOnline && nDetails.isConnectedToCurrentServer && nDetails.hasSession
            && !nDetails.isStationary && opts.induceMigration && opts['migrate-auto'] && nDepth < opts['migrate-target-depth']) {
            try {
                const result = await dnet.induceServerMigration(neighbor);
                if (result.success) log(ns, `Migrating ${neighbor}`);
            } catch {}
        }
    }

    await attemptPhishing(ns, dnet, opts);

    if (opts['labyrinth-auto'] && depth >= 7) {
        try {
            const report = await dnet.labreport();
            if (report.success) log(ns, `Labyrinth: ${report.message}`);
        } catch {}
    }

    savePasswordCache();
}

async function tryAuth(ns, dnet, host, details, opts) {
    const hint = details.passwordHint || '';
    const pwLen = Math.max(1, details.passwordLength || 1);
    const modelId = details.modelId || 'defaultModel';

    const cached = knownServers[host];
    if (cached?.password) {
        const result = await dnet.authenticate(host, cached.password);
        if (result.success) {
            const connResult = dnet.connectToSession(host, cached.password);
            if (connResult.success) log(ns, `Connected to ${host} (cached)`);
            return true;
        }
    }

    const data = details.data ?? '';
    const candidates = getCandidates(modelId, hint, pwLen, data);
    // max-auth-retries still applies as a safety ceiling (e.g. DeepGreen can
    // return thousands of numeric codes), but no longer artificially starves
    // puzzles like Laika4 or PHP 5.4 that need more than 3 guesses.
    const attempts = Math.min(candidates.length, opts['max-auth-retries']);

    for (let attempt = 0; attempt < attempts; attempt++) {
        const truncated = candidates[attempt].slice(0, Math.min(pwLen, 50));
        log(ns, `Auth ${host} (${modelId}, attempt ${attempt + 1}/${attempts})`);

        try {
            const result = await dnet.authenticate(host, truncated);
            if (result.success) {
                const connResult = dnet.connectToSession(host, truncated);
                if (connResult.success) {
                    log(ns, `Authenticated on ${host}!`);
                    knownServers[host].password = truncated;
                    savePasswordCache();
                    return true;
                }
            }
        } catch {}

        try {
            const logs = await dnet.heartbleed(host, { peek: true, logsToCapture: 1 });
            if (logs.success && logs.logs?.length) {
                log(ns, `Logs from ${host}: ${logs.logs[0]}`);
            }
        } catch {}
        await ns.sleep(100);
    }
    return false;
}

async function promoteStocksOnServer(ns, dnet) {
    try {
        const syms = ns.getStockSymbols ? ns.getStockSymbols() : [];
        if (!syms.length) return;
        const held = syms.map(sym => {
            try {
                const pos = ns.getStockPosition(sym);
                const price = ns.getStockPrice(sym);
                return { sym, value: pos[0] * price + pos[2] * price };
            } catch { return null; }
        }).filter(s => s && s.value > 0).sort((a, b) => b.value - a.value);

        for (const stock of held.slice(0, 3)) {
            try {
                const result = await dnet.promoteStock(stock.sym);
                if (result.success) log(ns, `Promoted ${stock.sym}`);
            } catch {}
            await ns.sleep(50);
        }
    } catch {}
}

async function attemptPhishing(ns, dnet, opts) {
    try {
        const result = await dnet.phishingAttack();
        log(ns, `Phish: ${result.message}`);
    } catch (e) {
        log(ns, `Phish fail: ${getErrorInfo(e)}`);
    }
}
