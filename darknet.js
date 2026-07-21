import { log, getConfiguration, getErrorInfo } from './helpers.js'
import { getCandidates } from './crackers.js'

const argsSchema = [
    ['interval', 10000],
    ['max-retries', 60],
    ['password-cache', '/data/dnet-passwords.txt'],
    ['launch-looters', true],
];

export function autocomplete(data, args) { data.flags(argsSchema); return []; }

export async function main(ns) {
    let dnet, opts;
    try { dnet = ns.dnet; opts = getConfiguration(ns, argsSchema); } catch { return; }
    if (!dnet) return;
    ns.disableLog('ALL');
    log(ns, 'darknet.js running');

    let cache = loadCache(ns, opts);

    while (true) {
        try {
            const server = ns.getHostname();

            if (dnet.isDarknetServer(server)) {
                await serverTick(ns, dnet, server, cache, opts);
            } else {
                await homeTick(ns, dnet, cache, opts);
            }

            saveCache(ns, cache, opts);
        } catch (e) {
            log(ns, `darknet error: ${getErrorInfo(e)}`);
        }
        await ns.sleep(opts.interval);
    }
}

// Runs on home: probe darknet from home's network, auth visible neighbors
async function homeTick(ns, dnet, cache, opts) {
    const visible = dnet.probe().filter(h => dnet.isDarknetServer(h));
    if (!visible.length) return;

    for (const host of visible) {
        if (!(host in cache)) cache[host] = {};
        try {
            await authServer(ns, dnet, host, cache[host], opts);
        } catch {}
    }
}

// Runs on a darknet server: open caches, phishing, auth neighbors
async function serverTick(ns, dnet, server, cache, opts) {
    // Open cache files
    const files = ns.ls(server).filter(f => f.endsWith('.cache'));
    for (const f of files) {
        try { await dnet.openCache(f, true); } catch {}
    }

    // Phishing attack
    try { await dnet.phishingAttack(); } catch {}

    // Memory reallocation
    try {
        const details = dnet.getServerDetails();
        if (details.blockedRam > 0) {
            await dnet.memoryReallocation(server);
            log(ns, `freed RAM on ${server}`);
        }
    } catch {}

    // Lab report at depth >= 7
    try {
        const depth = dnet.getDepth(server);
        if (depth >= 7) {
            const r = await dnet.labreport();
            if (r.success) log(ns, `lab: ${r.message}`);
        }
    } catch {}

    // Auth visible neighbors
    const neighbors = dnet.probe(false).filter(h => dnet.isDarknetServer(h));
    for (const n of neighbors) {
        if (!(n in cache)) cache[n] = {};
        try { await authServer(ns, dnet, n, cache[n], opts); } catch {}
    }

    // Launch looters on darknet servers that have session
    if (opts['launch-looters']) {
        for (const n of neighbors) {
            try {
                const nd = dnet.getServerDetails(n);
                if (nd.hasSession && !ns.isRunning('darknet-looter.js', n)) {
                    ns.scp(['darknet-looter.js', 'darknet-virus.js'], n, 'home');
                    ns.exec('darknet-looter.js', n, 1);
                    ns.exec('darknet-virus.js', n, 1);
                }
            } catch {}
        }
    }
}

async function authServer(ns, dnet, host, entry, opts) {
    const details = dnet.getServerDetails(host);
    if (!details.isOnline || !details.isConnectedToCurrentServer || details.hasSession)
        return;

    // Try cached password
    if (entry.password) {
        const r = await dnet.authenticate(host, entry.password);
        if (r.success) { dnet.connectToSession(host, entry.password); return; }
    }

    // Crack password
    const candidates = getCandidates(details.modelId, details.passwordHint || '',
        details.passwordLength || 1, details.data || '');
    const attempts = Math.min(candidates.length, opts['max-retries']);

    for (let i = 0; i < attempts; i++) {
        const pw = candidates[i].slice(0, Math.min(details.passwordLength || 50, 50));
        const r = await dnet.authenticate(host, pw);
        if (r.success) {
            dnet.connectToSession(host, pw);
            entry.password = pw;
            log(ns, `auth ${host} (${i + 1}/${attempts})`);
            return;
        }
        try {
            const hb = await dnet.heartbleed(host, { peek: true, logsToCapture: 1 });
            if (hb.success && hb.logs?.length)
                log(ns, `hb ${host}: ${hb.logs[0]}`);
        } catch {}
        await ns.sleep(100);
    }
}

function loadCache(ns, opts) {
    try { return JSON.parse(ns.read(opts['password-cache'])) || {}; } catch { return {}; }
}

function saveCache(ns, cache, opts) {
    const flat = {};
    for (const [h, d] of Object.entries(cache)) {
        if (d.password) flat[h] = d.password;
    }
    try { ns.write(opts['password-cache'], JSON.stringify(flat), 'w'); } catch {}
}
