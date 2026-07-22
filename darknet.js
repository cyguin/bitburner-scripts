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
                    if (details.modelId === 'AccountsManager_4.2' || details.modelId === 'DeepGreen'
                        || details.modelId === 'NIL' || details.modelId === 'OpenWebAccessPoint') {
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

    // DeepGreen: Mastermind with numeric match counts. NIL: Mastermind with yes/yesn't positional.
    if (model === 'DeepGreen') {
        return await authMastermind(ns, dnet, hostname, entry, l);
    }
    if (model === 'NIL') {
        return await authNIL(ns, dnet, hostname, entry, l);
    }
    if (model === 'OpenWebAccessPoint') {
        return await authOpenWeb(ns, dnet, hostname, entry, l);
    }

    // AccountsManager_4.2: higher/lower guessing game
    let lo = entry._binaryLo != null ? entry._binaryLo : 0;
    let hi = entry._binaryHi != null ? entry._binaryHi : 100;
    const range = h.match(/between\s*(\d+)\s*and\s*(\d+)/i);
    if (range) { lo = parseInt(range[1], 10); hi = parseInt(range[2], 10); }
    entry._binaryLo = lo;
    entry._binaryHi = hi;

    let guess = entry._guess != null ? entry._guess : Math.floor((lo + hi) / 2);

    for (let i = 0; i < 20; i++) {
        const pw = String(guess).padStart(l, '0');
        try {
            const r = await dnet.authenticate(hostname, pw);
            if (r && r.success) {
                entry.password = pw;
                entry.session = true;
                delete entry._guess; delete entry._binaryLo; delete entry._binaryHi;
                log(ns, `auth ${hostname} SUCCESS: ${pw}`);
                return true;
            }
            const fb = String(r?.data || '');
            if (fb.includes('Lower') || fb.includes('lower')) { hi = guess - 1; }
            else if (fb.includes('Higher') || fb.includes('higher')) { lo = guess + 1; }
            // If no feedback, keep lo/hi as-is and advance guess
            if (lo > hi) break;
        } catch (e) { ns.print(`authInteractive error: ${e}`); }
        guess = Math.floor((lo + hi) / 2);
        entry._guess = guess;
        entry._binaryLo = lo;
        entry._binaryHi = hi;
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

// NIL Mastermind: positional yes/yesn't feedback. Each position independently
// confirms whether the guessed digit matches the password at that position.
// Once we know a position is correct, lock it. Keep iterating unknown positions.
async function authNIL(ns, dnet, hostname, entry, l) {
    if (!entry._nilLocked) {
        entry._nilLocked = Array(l).fill(null); // null = unknown, '0'-'9' = locked
        entry._nilDigit = 0; // current digit being tested
        entry._nilPos = 0;  // current position for this digit
    }

    const locked = entry._nilLocked;
    const digitsCovered = locked.every(d => d != null);
    if (digitsCovered) {
        // All positions locked — construct the password
        const pw = locked.join('');
        const r = await dnet.authenticate(hostname, pw);
        if (r.success) {
            entry.password = pw;
            entry.session = true;
            delete entry._nilLocked; delete entry._nilDigit; delete entry._nilPos;
            log(ns, `auth ${hostname} SUCCESS: ${pw}`);
            return true;
        }
        // If final guess fails, reset and try different approach
        delete entry._nilLocked; delete entry._nilDigit; delete entry._nilPos;
        return false;
    }

    // Build a guess: locked positions use the known digit, others use test digit
    const testDigit = String(entry._nilDigit);
    let guess = [];
    for (let i = 0; i < l; i++) {
        guess.push(locked[i] != null ? locked[i] : testDigit);
    }
    const pw = guess.join('');
    const r = await dnet.authenticate(hostname, pw);
    if (r.success) {
        entry.password = pw;
        entry.session = true;
        delete entry._nilLocked; delete entry._nilDigit; delete entry._nilPos;
        log(ns, `auth ${hostname} SUCCESS: ${pw}`);
        return true;
    }

    // Parse positional feedback: comma-separated yes/yesn't
    const fb = (r.data || '').split(',');
    for (let i = 0; i < Math.min(l, fb.length); i++) {
        if (fb[i].trim() === 'yes' && locked[i] == null) {
            locked[i] = testDigit;
        }
    }

    // Move to next digit
    entry._nilDigit++;
    if (entry._nilDigit > 9) {
        // Shouldn't happen if feedback was correct, but reset
        delete entry._nilLocked; delete entry._nilDigit; delete entry._nilPos;
        return false;
    }
// OpenWebAccessPoint: password clues are in heartbleed traffic logs, not static data.
// Extract digit clues ("I can see a X and a Y"), build permutations, try them.
async function authOpenWeb(ns, dnet, hostname, entry, l) {
    // Collect digit clues across multiple heartbleed calls
    if (!entry._owClues) {
        entry._owClues = new Set();
        entry._owCandidates = null;
        entry._owIdx = 0;
    }

    // Extract "I can see a X and a Y" patterns from recent heartbleed
    const hb = await dnet.heartbleed(hostname, { peek: true, logsToCapture: 3 });
    if (hb.success && hb.logs) {
        for (const log of hb.logs) {
            const matches = log.match(/see a (\d) and a (\d)/gi);
            if (matches) {
                for (const m of matches) {
                    const d = m.match(/\d/g);
                    if (d) d.forEach(x => entry._owClues.add(x));
                }
            }
            // Also extract "X and Y are important" patterns
            const imp = log.match(/(\d) and (\d) are important/gi);
            if (imp) {
                for (const m of imp) {
                    const d = m.match(/\d/g);
                    if (d) d.forEach(x => entry._owClues.add(x));
                }
            }
        }
    }

    // Read Mastermind feedback from heartbleed data
    const hasFeedback = hb.logs?.some(log => /No characters are in the right place/i.test(log)
        || /characters?.*in the right place/i.test(log));
    if (hasFeedback && entry._owCandidates) {
        // Filter: remove the last guess from candidates if "no characters right"
        if (hb.logs?.some(log => /No characters are in the right place/i.test(log))
            && entry._owCandidates.length > 1) {
            entry._owCandidates = entry._owCandidates.filter(c => c !== entry._owLastGuess);
        }
        entry._owIdx = 0;
    }

    // Clues collected but not yet built into candidate list
    if (!entry._owCandidates || entry._owIdx >= entry._owCandidates.length) {
        const clues = [...entry._owClues];
        if (clues.length >= l) {
            // Generate all permutations of clue digits, plus extra combos with 0
            const candidates = new Set();
            for (const perm of permute(clues)) {
                const p = perm.slice(0, l).join('');
                if (p.length === l) candidates.add(p);
            }
            // Also try repeating the first clue digit
            const repeat = clues[0].repeat(l);
            candidates.add(repeat);
            entry._owCandidates = [...candidates];
        } else if (clues.length > 0) {
            // Not enough clues — pad with common digits
            entry._owCandidates = [clues.join('').padEnd(l, '0'), clues.join('').padEnd(l, '9')];
        } else {
            entry._owCandidates = ['0'.repeat(l)];
        }
        entry._owIdx = 0;
    }

    // Try next candidate
    for (let i = 0; i < Math.min(5, entry._owCandidates.length - entry._owIdx); i++) {
        const pw = entry._owCandidates[entry._owIdx];
        entry._owLastGuess = pw;
        entry._owIdx++;
        const r = await dnet.authenticate(hostname, pw);
        if (r.success) {
            entry.password = pw;
            entry.session = true;
            delete entry._owClues; delete entry._owCandidates; delete entry._owIdx; delete entry._owLastGuess;
            log(ns, `auth ${hostname} SUCCESS: ${pw}`);
            return true;
        }
        await ns.sleep(50);
    }
    return false;
}

function permute(arr) {
    if (arr.length <= 1) return [arr.slice()];
    const result = [];
    for (let i = 0; i < arr.length; i++) {
        const rest = permute(arr.filter((_, j) => j !== i));
        for (const r of rest) result.push([arr[i], ...r]);
    }
    return result;
}
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
