import { log, getConfiguration, getErrorInfo } from './helpers.js'
import { getCandidates } from './crackers.js'

const argsSchema = [
    ['interval', 5000],
    ['max-retries', 60],
    ['password-cache', '/data/dnet-passwords.txt'],
];

export function autocomplete(data) { return ['--tail']; }

export async function main(ns) {
    let dnet, opts;
    try { dnet = ns.dnet; opts = getConfiguration(ns, argsSchema); } catch { return; }
    if (!dnet) return;
    ns.disableLog('ALL');
    log(ns, `darknet on ${ns.getHostname()}`);

    let cache = loadCache(ns, opts);

    while (true) {
        try {
            const nearby = dnet.probe();

            for (const hostname of nearby) {
                if (!(hostname in cache)) cache[hostname] = {};

                const details = dnet.getServerDetails(hostname);
                if (!details.isConnectedToCurrentServer || !details.isOnline) continue;
                if (details.hasSession) { cache[hostname].session = true; continue; }

                // Try cached password via connectToSession (sync, any distance)
                if (cache[hostname].password) {
                    const r = dnet.connectToSession(hostname, cache[hostname].password);
                    if (r.success) {
                        cache[hostname].session = true;
                        log(ns, `connect ${hostname} (cached)`);
                    }
                }

                // Authenticate if not yet connected
                if (!cache[hostname].session) {
                    const candidates = getCandidates(
                        details.modelId, details.passwordHint || '',
                        details.passwordLength || 1, details.data || ''
                    );
                    const attempts = Math.min(candidates.length, opts['max-retries']);

                    for (let i = 0; i < attempts; i++) {
                        const pw = candidates[i].slice(0, Math.min(details.passwordLength || 50, 50));
                        const r = await dnet.authenticate(hostname, pw);
                        if (r.success) {
                            cache[hostname].password = pw;
                            cache[hostname].session = true;
                            log(ns, `auth ${hostname} (${i + 1}/${attempts})`);
                            break;
                        }
                        await ns.sleep(50);
                    }
                }

                // Spread this script to newly-authed servers
                if (cache[hostname].session && !cache[hostname].deployed) {
                    try {
                        ns.scp(ns.getScriptName(), hostname);
                        ns.scp(['darknet-looter.js', 'darknet-virus.js', 'crackers.js', 'helpers.js'], hostname, ns.getHostname());
                        ns.exec(ns.getScriptName(), hostname, { preventDuplicates: true });
                        ns.exec('darknet-looter.js', hostname, { preventDuplicates: true });
                        ns.exec('darknet-virus.js', hostname, { preventDuplicates: true });
                        cache[hostname].deployed = true;
                        log(ns, `deployed to ${hostname}`);
                    } catch {}
                }
            }

            // Server-local ops
            if (dnet.isDarknetServer(ns.getHostname())) {
                for (const f of ns.ls(ns.getHostname()).filter(f => f.endsWith('.cache')))
                    try { const r = await dnet.openCache(f, true); } catch {}
                try { await dnet.phishingAttack(); } catch {}
                try {
                    const details = dnet.getServerDetails();
                    if (details.blockedRam > 0) await dnet.memoryReallocation(ns.getHostname());
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
    for (const [h, d] of Object.entries(cache)) if (d.password) flat[h] = d.password;
    try { ns.write(opts['password-cache'], JSON.stringify(flat), 'w'); } catch {}
}
