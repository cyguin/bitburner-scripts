import { getCandidates } from './crackers.js'

const DB = '/data/dnet-passwords.txt';

export async function main(ns) {
    ns.disableLog('ALL');
    let dnet;
    try { dnet = ns.dnet; } catch { return; }
    if (!dnet || !dnet.isDarknetServer(ns.getHostname())) return;

    let cache = loadCache(ns);
    let lastHits = 0;

    while (true) {
        try {
            const server = ns.getHostname();
            const neighbors = dnet.probe(false).filter(h => dnet.isDarknetServer(h));

            for (const host of neighbors) {
                try {
                    const hb = await dnet.heartbleed(host, { peek: true, logsToCapture: 2 });
                    if (hb.success && hb.logs?.length) {
                        for (const log of hb.logs) {
                            const pw = harvestPassword(log, host);
                            if (pw && !(host in cache)) {
                                cache[host] = pw;
                                lastHits++;
                            }
                        }
                    }
                } catch {}
            }

            if (lastHits > 0) {
                saveCache(ns, cache);
                lastHits = 0;
            }

            // Try auth with harvested passwords
            for (const [host, pw] of Object.entries(cache)) {
                try {
                    const r = await dnet.authenticate(host, pw);
                    if (r.success) dnet.connectToSession(host, pw);
                } catch {}
            }
        } catch {}
        await ns.sleep(10000);
    }
}

function harvestPassword(log, hostname) {
    if (!log || typeof log !== 'string') return null;
    const direct = log.match(/--([a-zA-Z0-9]+)--/);
    if (direct) return direct[1];
    const passcode = log.match(/passcode:\s*['"]?(\w+)['"]?\s*\./i)
        || log.match(/passcode:\s*['"]?(\w+)['"]?\s*\.\./i);
    if (passcode) return passcode[1];
    const neighbor = log.match(/Connecting to\s+(\S+):(\w+)\s/i);
    if (neighbor) return neighbor[2];
    const auth = log.match(/passwordAttempted['"]?\s*:\s*['"]?(\w+)/i);
    if (auth) return auth[1];
    return null;
}

function loadCache(ns) {
    try { return JSON.parse(ns.read(DB)) || {}; } catch { return {}; }
}

function saveCache(ns, cache) {
    try { ns.write(DB, JSON.stringify(cache), 'w'); } catch {}
}
