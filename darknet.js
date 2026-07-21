import { log, getConfiguration, getErrorInfo, getNsDataThroughFile } from './helpers.js'
import { getCandidates } from './crackers.js'

const argsSchema = [
    ['interval', 5000],
    ['max-retries', 60],
    ['password-cache', '/data/dnet-passwords.txt'],
];

export function autocomplete(data, args) { data.flags(argsSchema); return []; }

export async function main(ns) {
    let dnet, opts;
    try { dnet = ns.dnet; opts = getConfiguration(ns, argsSchema); } catch { return; }
    if (!dnet) return;
    ns.disableLog('ALL');

    const server = ns.getHostname();
    const isDarknet = dnet.isDarknetServer(server);
    log(ns, `darknet on ${server}${isDarknet ? ' (dnet)' : ''}`);

    let cache = loadCache(ns, opts);

    while (true) {
        try {
            const visible = dnet.probe(false).filter(h => dnet.isDarknetServer(h));
            let newlyAuthed = false;

            for (const host of visible) {
                if (!(host in cache)) cache[host] = {};
                const entry = cache[host];

                if (entry.session) continue; // Already have session

                const details = dnet.getServerDetails(host);
                if (!details.isOnline || !details.isConnectedToCurrentServer || details.hasSession) {
                    if (details.hasSession) entry.session = true;
                    continue;
                }

                // Try cached password
                if (entry.password) {
                    const r = await dnet.authenticate(host, entry.password);
                    if (r.success) {
                        dnet.connectToSession(host, entry.password);
                        entry.session = true;
                        log(ns, `auth ${host} (cached)`);
                        newlyAuthed = true;
                        continue;
                    }
                }

                // Crack password
                const candidates = getCandidates(details.modelId,
                    details.passwordHint || '', details.passwordLength || 1, details.data || '');
                const attempts = Math.min(candidates.length, opts['max-retries']);

                for (let i = 0; i < attempts; i++) {
                    const pw = candidates[i].slice(0, Math.min(details.passwordLength || 50, 50));
                    const r = await dnet.authenticate(host, pw);
                    if (r.success) {
                        dnet.connectToSession(host, pw);
                        entry.password = pw;
                        entry.session = true;
                        log(ns, `auth ${host} (${i + 1}/${attempts})`);
                        newlyAuthed = true;
                        break;
                    }
                    await ns.sleep(50);
                }
            }

            // Propagate: copy ourselves to newly-authed servers so they can go deeper
            if (newlyAuthed) {
                for (const host of visible) {
                    const entry = cache[host];
                    if (!entry.session || entry.deployed) continue;
                    try {
                        ns.scp([ns.getScriptName(), 'darknet-looter.js', 'darknet-virus.js', 'crackers.js', 'helpers.js'], host, server);
                        ns.exec(ns.getScriptName(), host, 1);
                        ns.exec('darknet-looter.js', host, 1);
                        ns.exec('darknet-virus.js', host, 1);
                        entry.deployed = true;
                        log(ns, `deployed to ${host}`);
                    } catch {}
                }
            }

            // Server-local ops (only if we're ON a darknet server)
            if (isDarknet) {
                for (const f of ns.ls(server).filter(f => f.endsWith('.cache'))) {
                    try { const r = await dnet.openCache(f, true); } catch {}
                }
                try { await dnet.phishingAttack(); } catch {}
                try {
                    const details = dnet.getServerDetails();
                    if (details.blockedRam > 0) {
                        const r = await dnet.memoryReallocation(server);
                        if (r.success) log(ns, `freed ${details.blockedRam}GB on ${server}`);
                    }
                } catch {}
            }

            saveCache(ns, cache, opts);
        } catch (e) {
            log(ns, `error: ${getErrorInfo(e)}`);
        }
        await ns.sleep(opts.interval);
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
