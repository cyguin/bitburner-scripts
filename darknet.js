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
                        || details.modelId === 'NIL' || details.modelId === 'OpenWebAccessPoint'
                        || details.modelId === 'Pr0verFl0' || details.modelId === 'Factori-Os'
                        || details.modelId === 'BigMo%od' || details.modelId === 'KingOfTheHill') {
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
                        // Deploy labyrinth solver to labyrinth servers
                        if (details.modelId === '(The Labyrinth)') {
                            ns.scp('labyrinth.js', hostname, ns.getHostname());
                            ns.exec('labyrinth.js', hostname, 1);
                            log(ns, `labyrinth solver deployed to ${hostname}`);
                        }
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

function saveCache(ns, cache, opts) {
    const flat = {};
    for (const [h, d] of Object.entries(cache)) {
        const entry = {};
        if (d.password) entry.pw = d.password;
        if (d._guess != null) entry.g = d._guess;
        if (d._binaryLo != null) entry.lo = d._binaryLo;
        if (d._binaryHi != null) entry.hi = d._binaryHi;
        if (Object.keys(entry).length) flat[h] = entry;
    }
    try { ns.write(opts['password-cache'], JSON.stringify(flat), 'w'); } catch {}
}

function loadCache(ns, opts) {
    try {
        const raw = JSON.parse(ns.read(opts['password-cache'])) || {};
        const cache = {};
        for (const [h, d] of Object.entries(raw)) {
            cache[h] = {};
            if (d.pw) cache[h].password = d.pw;
            if (d.g != null) cache[h]._guess = d.g;
            if (d.lo != null) cache[h]._binaryLo = d.lo;
            if (d.hi != null) cache[h]._binaryHi = d.hi;
        }
        return cache;
    } catch { return {}; }
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
    // Pr0verFl0: classic buffer overflow. Send the same string twice (length = 2*l).
    // It overflows the password buffer into the expected-value field, making them match.
    if (model === 'Pr0verFl0') {
        const payload = 'aaaaa'.slice(0, l) + 'aaaaa'.slice(0, l);
        const r = await dnet.authenticate(hostname, payload);
        if (r.success) { entry.password = payload; entry.session = true; log(ns, `auth ${hostname} SUCCESS: bo`); return true; }
        return false;
    }
    if (model === 'Factori-Os') {
        return await authFactoriOs(ns, dnet, hostname, entry, l);
    }
    if (model === 'BigMo%od') {
        return await authBigMod(ns, dnet, hostname, entry, l);
    }
    if (model === 'KingOfTheHill') {
        return await authKingOfTheHill(ns, dnet, hostname, entry, l);
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
    await ns.sleep(50);
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

    // Extract "I can see a X and a Y" patterns and credential leaks from heartbleed
    const hb = await dnet.heartbleed(hostname, { peek: true, logsToCapture: 5 });
    if (hb.success && hb.logs) {
        for (const log of hb.logs) {
            // Direct credential leaks: other servers authenticating with this one's password
            // Format: hostname:password or "passcode: NNNNN" or "Logging in with passcode: NNNNN"
            const leak = log.match(/:(\d+)$/m)
                || log.match(/passcode:\s*(\d+)/i)
                || log.match(/password:\s*(\d+)/i);
            if (leak && leak[1].length === l) {
                entry._owCandidates = [leak[1]];
                entry._owIdx = 0;
            }
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

async function authFactoriOs(ns, dnet, hostname, entry, l) {
    if (!entry._foPrimes) entry._foPrimes = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47,
        53, 59, 61, 67, 71, 73, 79, 83, 89, 97, 101, 103, 107, 109, 113];
    if (!entry._foIdx) entry._foIdx = 0;
    if (!entry._foProduct) entry._foProduct = 1;

    const primes = entry._foPrimes;
    for (let i = entry._foIdx; i < primes.length; i++) {
        entry._foIdx = i + 1;
        const p = primes[i];
        const pStr = String(p);

        // Does this prime divide the current remaining password?
        const r = await dnet.authenticate(hostname, pStr);
        await ns.sleep(30);
        if (r.success) { entry.password = pStr; entry.session = true; return true; }
        if (r.data !== 'true') continue;

        // Keep multiplying by this prime while it still divides
        let factor = entry._foProduct * p;
        while (true) {
            const fStr = String(factor);
            const r2 = await dnet.authenticate(hostname, fStr);
            if (r2.success) { entry.password = fStr; entry.session = true; return true; }
            // Test if factor still divides (it's a partial product, not the full password)
            if (r2.data !== 'true') { factor = Math.floor(factor / p); break; }
            factor *= p;
            await ns.sleep(30);
        }
        entry._foProduct = factor;
    }
    return false;
}

async function authBigMod(ns, dnet, hostname, entry, l) {
    if (!entry._bmRem) entry._bmRem = {};
    if (!entry._bmN) entry._bmN = 2;

    const rem = entry._bmRem;
    let n = entry._bmN;
    for (let i = 0; i < 8; i++, n++) {
        if ((n - 1) % 32 === 0) n++; // skip n where second mod = 1 (always 0)
        entry._bmN = n + 1;
        const r = await dnet.authenticate(hostname, String(n));
        await ns.sleep(30);
        if (r.success) { entry.password = String(n); entry.session = true; return true; }
        const val = parseInt(r.data);
        if (!isNaN(val)) rem[n] = val;

        // CRT: product of moduli. If it covers the possible password range, reconstruct.
        const mods = Object.keys(rem).map(Number);
        const M = mods.reduce((a, b) => a * b, 1);
        const maxPass = Math.pow(10, l);
        if (M > maxPass) {
            // CRT reconstruction
            let x = 0;
            for (const m of mods) {
                const Mi = M / m;
                const inv = modInverse(Mi % m, m);
                x = (x + rem[m] * Mi * inv) % M;
            }
            const pw = String(x);
            const r2 = await dnet.authenticate(hostname, pw);
            if (r2.success) { entry.password = pw; entry.session = true; return true; }
            // Off by M? Try x + M, x + 2M...
            for (let k = 1; k < 5; k++) {
                const pw2 = String(x + k * M);
                if (pw2.length > l) break;
                const r3 = await dnet.authenticate(hostname, pw2);
                if (r3.success) { entry.password = pw2; entry.session = true; return true; }
            }
            // Reset: collected enough info but CRT didn't work — moduli conflict
            entry._bmRem = {}; entry._bmN = 2;
            return false;
        }
    }
    return false;
}

async function authKingOfTheHill(ns, dnet, hostname, entry, l) {
    // Scan the full range. For length-L numeric, range is 0 to 10^L-1.
    // When within 3% of the answer, the game switches to a clean single-peak
    // Gaussian centered on the password with peak altitude 10,000.
    if (!entry._kohTried) entry._kohTried = new Set();
    const tried = entry._kohTried;

    // Try a few values each call, pick the one with highest altitude
    const range = Math.min(Math.pow(10, l), 10000);
    let bestX = entry._kohBestX;
    let bestAlt = entry._kohBestAlt || 0;

    // Phase 1: coarse scan
    if (!entry._kohCoarse) {
        const step = Math.max(1, Math.floor(range / 20));
        for (let x = 0; x < range && tried.size < 50; x += step) {
            if (tried.has(x)) continue;
            tried.add(x);
            const pw = String(x).padStart(l, '0');
            const r = await dnet.authenticate(hostname, pw);
            if (r.success) { entry.password = pw; entry.session = true; return true; }
            const alt = parseFloat(r.data) || 0;
            if (alt > bestAlt) { bestAlt = alt; bestX = x; }
            if (alt >= 10000) break;
            await ns.sleep(30);
        }
        entry._kohCoarse = tried.size >= 50 || bestAlt >= 9000;
        entry._kohBestX = bestX;
        entry._kohBestAlt = bestAlt;
        return false;
    }

    // Phase 2: fine scan around best coarse guess
    const margin = Math.max(1, Math.floor(range * 0.05));
    let start = Math.max(0, (bestX || 0) - margin);
    let end = Math.min(range - 1, (bestX || 0) + margin);
    for (let x = start; x <= end && tried.size < 100; x++) {
        if (tried.has(x)) continue;
        tried.add(x);
        const pw = String(x).padStart(l, '0');
        const r = await dnet.authenticate(hostname, pw);
        if (r.success) { entry.password = pw; entry.session = true; return true; }
        const alt = parseFloat(r.data) || 0;
        if (alt > bestAlt) { bestAlt = alt; bestX = x; }
        if (alt >= 10000) break;
        await ns.sleep(30);
    }
    entry._kohBestX = bestX;
    entry._kohBestAlt = bestAlt;

    // Phase 3: if we found a peak >= 10000, it's the password
    if (bestAlt >= 10000) {
        const pw = String(bestX).padStart(l, '0');
        const r = await dnet.authenticate(hostname, pw);
        if (r.success) { entry.password = pw; entry.session = true; return true; }
    }
    return false;
}

function modInverse(a, m) {
    let [m0, x0, x1] = [m, 0, 1];
    while (a > 1) {
        const q = Math.floor(a / m);
        [m, a] = [a % m, m];
        [x0, x1] = [x1 - q * x0, x0];
    }
    return x1 < 0 ? x1 + m0 : x1;
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
