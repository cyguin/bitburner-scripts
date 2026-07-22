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

            // Status line: log what we see
            log(ns, `${ns.getHostname()}: ${nearby.length} nearby, ${nearby.filter(h => cache[h]?.session).length} authed`);

            for (const hostname of nearby) {
                if (!(hostname in cache)) cache[hostname] = {};

                const details = dnet.getServerDetails(hostname);
                if (!details.isOnline) { if (!cache[hostname]._loggedOffline) { log(ns, `${hostname}: offline`); cache[hostname]._loggedOffline = true; } continue; }
                if (!details.isConnectedToCurrentServer) { if (!cache[hostname]._loggedNoConn) { log(ns, `${hostname}: not connected (${details.modelId || '?'})`); cache[hostname]._loggedNoConn = true; } continue; }
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
                    // AccountsManager_4.2 or DeepGreen are interactive — handle inline
                    if (details.modelId === 'AccountsManager_4.2' || details.modelId === 'DeepGreen') {
                        await authInteractive(ns, dnet, hostname, cache[hostname], details);
                    } else {
                    const candidates = getCandidates(
                        details.modelId, details.passwordHint || '',
                        details.passwordLength || 1, details.data || ''
                    );
                    const attempts = Math.min(candidates.length, opts['max-retries']);
                    if (!cache[hostname]._loggedModel) {
                        log(ns, `${hostname}: ${details.modelId} (${details.passwordHint || 'no hint'}, len ${details.passwordLength}) trying ${attempts} candidates`);
                        cache[hostname]._loggedModel = true;
                    }

                    for (let i = 0; i < attempts; i++) {
                        const pw = candidates[i].slice(0, Math.min(details.passwordLength || 50, 50));
                        const r = await dnet.authenticate(hostname, pw);
                        if (r.success) {
                            cache[hostname].password = pw;
                            cache[hostname].session = true;
                            log(ns, `auth ${hostname} SUCCESS (${i + 1}/${attempts})`);
                            break;
                        }
                        await ns.sleep(50);
                    }
                    if (!cache[hostname].session && !cache[hostname]._loggedFail) {
                        log(ns, `auth ${hostname}: FAILED all ${attempts} attempts`);
                        cache[hostname]._loggedFail = true;
                    }
                    } // end else (non-interactive auth)
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

async function authInteractive(ns, dnet, hostname, entry, details) {
    const h = details.passwordHint || '';
    const l = details.passwordLength || 1;
    const model = details.modelId;

    // DeepGreen: Mastermind. Read exact/position match counts from r.data.
    if (model === 'DeepGreen') {
        return await authMastermind(ns, dnet, hostname, entry, l);
    }

    // AccountsManager_4.2: higher/lower guessing game
    const range = h.match(/between\s*(\d+)\s*and\s*(\d+)/i);
    let lo = range ? parseInt(range[1], 10) : 0;
    let hi = range ? parseInt(range[2], 10) : 100;
    let guess = entry._guess != null ? entry._guess : Math.floor((lo + hi) / 2);

    for (let i = 0; i < 20; i++) {
        const pw = String(guess).padStart(l, '0');
        const r = await dnet.authenticate(hostname, pw);
        if (r.success) {
            entry.password = pw;
            entry.session = true;
            delete entry._guess;
            log(ns, `auth ${hostname} SUCCESS: ${pw}`);
            return true;
        }
        const fb = r.data || '';
        if (fb.includes('Lower') || fb.includes('lower')) hi = guess - 1;
        else if (fb.includes('Higher') || fb.includes('higher')) lo = guess + 1;
        if (lo > hi) break;
        guess = Math.floor((lo + hi) / 2);
        entry._guess = guess;
        await ns.sleep(50);
    }
    return false;
}

// DeepGreen Mastermind solver. Reads match counts from r.data ("1,0" format).
async function authMastermind(ns, dnet, hostname, entry, l) {
    // Start fresh if no state or previous guess didn't match expected feedback
    if (!entry._mmCandidates || !entry._mmGuess) {
        // Generate all length-L numeric combinations
        const digits = Math.min(l, 4);
        const max = Math.min(Math.pow(10, digits), 10000);
        entry._mmCandidates = [];
        for (let i = 0; i < max; i++)
            entry._mmCandidates.push(String(i).padStart(digits, '0'));
        entry._mmGuess = 0;
    }

    for (let i = entry._mmGuess; i < entry._mmCandidates.length; i++) {
        const pw = entry._mmCandidates[i];
        entry._mmGuess = i + 1;
        const r = await dnet.authenticate(hostname, pw);
        if (r.success) {
            entry.password = pw;
            entry.session = true;
            delete entry._mmCandidates; delete entry._mmGuess;
            log(ns, `auth ${hostname} SUCCESS: ${pw}`);
            return true;
        }
        const fb = (r.data || '0,0').split(',').map(Number);
        const [exact, wrongPos] = [fb[0] || 0, fb[1] || 0];
        if (exact + wrongPos > 0) {
            // This guess had matches — filter candidates using Mastermind logic
            entry._mmCandidates = entry._mmCandidates.filter(c =>
                getMastermindScore(pw, c)[0] === exact &&
                getMastermindScore(pw, c)[1] === wrongPos
            );
            entry._mmGuess = 0;
            log(ns, `${hostname}: ${pw} -> (${exact},${wrongPos}) narrowed to ${entry._mmCandidates.length}`);
            return false;
        }
        await ns.sleep(50);
    }
    delete entry._mmCandidates; delete entry._mmGuess;
    return false;
}

function getMastermindScore(guess, target) {
    let exact = 0, wrongPos = 0;
    const gUsed = [], tUsed = [];
    for (let j = 0; j < guess.length; j++) {
        if (guess[j] === target[j]) { exact++; gUsed[j] = tUsed[j] = true; }
    }
    for (let j = 0; j < guess.length; j++) {
        if (gUsed[j]) continue;
        for (let k = 0; k < target.length; k++) {
            if (tUsed[k]) continue;
            if (guess[j] === target[k]) { wrongPos++; tUsed[k] = true; break; }
        }
    }
    return [exact, wrongPos];
}
