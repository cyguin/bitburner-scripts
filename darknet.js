import { getCandidates, romanHint, permute } from './crackers.js'

export function autocomplete(data) { return ['--tail']; }

// Bump this whenever any worm file changes.
//
// exec() with preventDuplicates returns 0 when the script is already
// running, so scp updates the file on disk while the live process
// keeps executing whatever it started with. Without this the worm never
// updates itself: a fix only reaches a host when its scripts happen to be
// killed by a mutation, which is why an old solver can sit there re-sending
// the same dead guess for hours after being replaced.
//
// Each instance re-reads its own source - already overwritten by scp - and
// exits when the version on disk no longer matches the one it started with.
// Restart comes from above: peers re-attempt their deploy every
// DEPLOY_RETRY_CYCLES ticks, and autopilot.js redeploys from home whenever no
// darknet.js is running on any reachable darknet host.
//
// ns.read and ns.getScriptName are both free, so this costs no RAM.
const WORM_VERSION = 2;

function isStale(ns) {
    try {
        const m = ns.read(ns.getScriptName()).match(/^const WORM_VERSION = (\d+)/m);
        return !!m && Number(m[1]) !== WORM_VERSION;
    } catch { return false; }
}

// How often an already-deployed host gets another exec attempt. Cheap (exec
// returns 0 while an instance is live) and it's what restarts a peer that
// just exited on a version bump.
const DEPLOY_RETRY_CYCLES = 20;

const INTERACTIVE_MODELS = new Set([
    'AccountsManager_4.2', 'DeepGreen', 'NIL', 'OpenWebAccessPoint',
    'Pr0verFl0', 'Factori-Os', 'BigMo%od', 'KingOfTheHill', 'RateMyPix.Auth',
    'BellaCuore', '2G_cellular', 'PHP 5.4',
]);

// Higher/lower guessing games. Same search, different vocabulary and different
// source for the range - see hiLoDirection() and hiLoPool().
const HILO_MODELS = { 'AccountsManager_4.2': 'AccountsManager', 'BellaCuore': 'BellaCuore' };

export async function main(ns) {
    let dnet;
    try { dnet = ns.dnet; } catch { return; }
    if (!dnet) return;
    ns.disableLog('ALL');
    ns.print(`darknet on ${ns.getHostname()}`);

    let cache = loadCache(ns);

    while (true) {
        if (isStale(ns)) {
            ns.print(`newer darknet.js on disk (was v${WORM_VERSION}) - exiting so it can start`);
            return;
        }
        try {
            const nearby = dnet.probe();

            // Status line: log what we see
            ns.print(`${ns.getHostname()}: ${nearby.length} nearby, ${nearby.filter(h => cache[h]?.session).length} authed`);

            for (const hostname of nearby) {
                if (!(hostname in cache)) cache[hostname] = {};

                const details = dnet.getServerDetails(hostname);
                if (!details.isOnline) { if (!cache[hostname]._loggedOffline) { ns.print(`${hostname}: offline`); cache[hostname]._loggedOffline = true; } continue; }
                if (!details.isConnectedToCurrentServer) { if (!cache[hostname]._loggedNoConn) { ns.print(`${hostname}: not connected (${details.modelId || '?'})`); cache[hostname]._loggedNoConn = true; } continue; }
                if (details.hasSession) cache[hostname].session = true;

                // Try cached password via connectToSession (sync, any distance)
                if (cache[hostname].password) {
                    const r = dnet.connectToSession(hostname, cache[hostname].password);
                    if (r.success) {
                        cache[hostname].session = true;
                        ns.print(`connect ${hostname} (cached)`);
                    }
                }
                // Authenticate if not yet connected
                if (!cache[hostname].session) {
                    // These models can't be solved from a static candidate list -
                    // each needs the response to one attempt before it can pick
                    // the next. handled inline by authInteractive().
                    if (INTERACTIVE_MODELS.has(details.modelId)) {
                        const authed = await authInteractive(ns, dnet, hostname, cache[hostname], details);
                        if (authed && !cache[hostname].deployed) {
                            await deployWorm(ns, hostname, cache[hostname], details);
                        }
                    } else {
                        const candidates = getCandidates(
                            details.modelId, details.passwordHint || '',
                            details.passwordLength || 1, details.data || ''
                        );
                        // Prefer candidates that already match the password
                        // length; only fall back to the raw list if none do.
                        // The previous code truncated every candidate with
                        // .slice(0, passwordLength), which silently corrupted
                        // any candidate longer than the password instead of
                        // skipping it - a decoded "168" became a guess of "16",
                        // resent every cycle forever.
                        const plen = details.passwordLength || 0;
                        const fitted = plen ? candidates.filter(c => c.length === plen) : candidates;
                        const usable = fitted.length ? fitted : candidates;
                        const attempts = Math.min(usable.length, 60);
                        if (!cache[hostname]._loggedModel) {
                            ns.print(`${hostname}: ${details.modelId} (${details.passwordHint || 'no hint'}, len ${details.passwordLength}) trying ${attempts} candidates`);
                            cache[hostname]._loggedModel = true;
                        }
                    for (let i = 0; i < attempts; i++) {
                        const pw = usable[i];
                        const r = await dnet.authenticate(hostname, pw);
                        if (r.success) {
                            cache[hostname].password = pw;
                            cache[hostname].session = true;
                            ns.print(`auth ${hostname} SUCCESS (${i + 1}/${attempts})`);
                            // Spread immediately — darknet topology mutates every 30s, exec must
                            // happen before the connection drops
                            if (!cache[hostname].deployed) {
                                await deployWorm(ns, hostname, cache[hostname], details);
                            }
                            break;
                        }
                        await ns.sleep(50);
                    }
                    if (!cache[hostname].session && !cache[hostname]._loggedFail) {
                        ns.print(`auth ${hostname}: FAILED all ${attempts} attempts`);
                        cache[hostname]._loggedFail = true;
                    }
                    } // end else (non-interactive auth)
                }
                // Deploy once we have a session, and keep re-attempting on a
                // slow tick. exec returns 0 while an instance is already live,
                // so the retry costs nothing and is what restarts a host whose
                // worm just exited on a version bump.
                if (cache[hostname].session) {
                    const e = cache[hostname];
                    e._deployTick = (e._deployTick || 0) + 1;
                    if (!e.deployed || e._deployTick % DEPLOY_RETRY_CYCLES === 0) {
                        await deployWorm(ns, hostname, e, details);
                    }
                }
            }

            // Server-local ops (cache opening, phishing, RAM-block draining)
            // live in darknet-looter.js, which this script execs onto every
            // host it cracks. They used to be duplicated here as well, which
            // bought nothing - both scripts run on the same server - and cost
            // this one openCache (2GB) + phishingAttack (2GB) +
            // memoryReallocation (1GB) + ls (0.2GB) of a budget that has to
            // fit alongside the looter and the virus on a 16GB server.

            saveCache(ns, cache);
        } catch (e) {
            ns.print(`error: ${e?.message || e}`);
        }
        await ns.sleep(1000);
    }
}

function saveCache(ns, cache) {
    const flat = {};
    for (const [h, d] of Object.entries(cache)) {
        // Only the solved password is worth persisting. Interactive solver
        // state is in-memory only: it's large (candidate pools), and it's
        // invalidated by a topology mutation anyway.
        if (d.password) flat[h] = { pw: d.password };
    }
    try { ns.write('/data/dnet-passwords.txt', JSON.stringify(flat), 'w'); } catch {}
} 

function loadCache(ns) {
    try {
        const raw = JSON.parse(ns.read('/data/dnet-passwords.txt')) || {};
        const cache = {};
        for (const [h, d] of Object.entries(raw)) {
            cache[h] = {};
            if (d.pw) cache[h].password = d.pw;
        }
        return cache;
    } catch { return {}; }
}

async function authInteractive(ns, dnet, hostname, entry, details) {
    const l = details.passwordLength || 1;
    const model = details.modelId;

    if (model === 'NIL') {
        return await authNIL(ns, dnet, hostname, entry, details);
    }
    if (model === 'OpenWebAccessPoint') {
        return await authOpenWeb(ns, dnet, hostname, entry, details);
    }
    // Pr0verFl0: classic buffer overflow. Send the same string twice (length = 2*l).
    // It overflows the password buffer into the expected-value field, making them match.
    // (Was 'aaaaa'.slice(0, l) twice, which silently capped the payload at 10
    // chars and stopped overflowing correctly for any password longer than 5.)
    if (model === 'Pr0verFl0') {
        const payload = 'a'.repeat(l * 2);
        const r = await dnet.authenticate(hostname, payload);
        if (r.success) { entry.password = payload; entry.session = true; ns.print(`auth ${hostname} SUCCESS: bo`); return true; }
        return false;
    }
    if (model === 'Factori-Os') {
        return await authFactoriOs(ns, dnet, hostname, entry, details);
    }
    if (model === 'BigMo%od') {
        return await authBigMod(ns, dnet, hostname, entry, details);
    }
    if (model === 'KingOfTheHill') {
        return await authKingOfTheHill(ns, dnet, hostname, entry, details);
    }

    if (model === 'PHP 5.4') {
        return await authSortedEcho(ns, dnet, hostname, entry, details);
    }
    if (model === '2G_cellular') {
        return await authTimingAttack(ns, dnet, hostname, entry, details);
    }
    if (HILO_MODELS[model]) {
        return await authHiLo(ns, dnet, hostname, entry, details, HILO_MODELS[model]);
    }
    if (BULLS_MODELS[model]) {
        return await authBullsOracle(ns, dnet, hostname, entry, details, BULLS_MODELS[model]);
    }
    return false;
}

// Reads the puzzle feedback for a password attempt we just made.
//
// This is THE thing every interactive solver in this file got wrong.
// ns.dnet.authenticate() resolves to a bare {success, code, message} - it
// carries a `data` field ONLY for labyrinth servers (NetscriptFunctions/
// Darknet.ts branches on isLabyrinthServer before building the return value).
// For every puzzle model, `r.data` is undefined, so any solver keying off it
// is reading nothing forever.
//
// The feedback is real, it just travels a different route: checkPassword()
// builds a PasswordResponse and getAuthResult() hands it to
// logPasswordAttempt(), which pushes it onto the server's packet log. The only
// way a script sees it is to read that log back with heartbleed(). The in-game
// docs say so outright: "Use await ns.dnet.heartbleed(hostname) to check that
// server's logs and get clues after you attempt a password."
//
// Auth entries arrive as JSON strings, e.g.
//   {"code":401,"message":"The password is a number between 0 and 100",
//    "data":"Lower","passwordAttempted":"50"}
// Logs are unshifted newest-first, but noise lines get interleaved on both
// logPasswordAttempt() and getServerLogs(), so match on passwordAttempted
// rather than trusting index 0. peek:true so we don't splice the log out from
// under the other worm scripts.
// Capture window. Our auth entry lands at index 0, but
// populateServerLogsWithNoise() runs again inside getServerLogs() and unshifts
// floor(elapsed / logTrafficInterval) noise lines ahead of it - and `elapsed`
// includes heartbleed's own network delay, which is 1.5x an authenticate().
// On a chatty server that easily buries the entry past a window of 5, which
// reads as "no feedback" and silently degrades every solver to a blind sweep.
// Capturing more costs nothing: getServerLogs() just slices, and peek:true
// doesn't consume. 200 is MAX_LOG_LINES upstream, i.e. everything retained, so
// the window can never be what loses the entry. Scanning newest-first means a
// stale entry for the same attempt can't win over the fresh one either.
const FEEDBACK_LOG_LINES = 200;

// Returns the parsed PasswordResponse for our attempt, or null. Callers that
// only want the hint payload use readAuthFeedback(); this exists for the ones
// that also want `message`, which sometimes restates the answer in prose.
async function readAuthEntry(ns, dnet, hostname, attempted, lines = FEEDBACK_LOG_LINES) {
    let hb;
    try {
        hb = await dnet.heartbleed(hostname, { peek: true, logsToCapture: lines });
    } catch (e) {
        return null;
    }
    // Charisma below the server's requirement, or a dropped connection, both
    // land here - the caller degrades to a blind sweep rather than stalling.
    if (!hb || !hb.success || !Array.isArray(hb.logs)) return null;
    for (const line of hb.logs) {
        if (typeof line !== 'string' || line.charAt(0) !== '{') continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (o && o.passwordAttempted === attempted && o.data != null) return o;
    }
    return null;
}

async function readAuthFeedback(ns, dnet, hostname, attempted, lines = FEEDBACK_LOG_LINES) {
    const o = await readAuthEntry(ns, dnet, hostname, attempted, lines);
    return o ? String(o.data) : null;
}

// The solvers treat unreadable feedback as "stop, resume next cycle" rather
// than as a score, so a persistent heartbleed failure looks like silence from
// outside. Say so once per host, otherwise it just sits there.
function noFeedback(ns, st, hostname, label) {
    if (!st.warned) {
        st.warned = true;
        ns.print(`${hostname}: ${label} could not read heartbleed feedback (charisma gate?), stalled`);
    }
    return false;
}

// Higher/lower number guessing games: AccountsManager_4.2 and BellaCuore.
//
// Both compare the same way, they just say it differently:
//     GuessNumber:   attempt > password ? "Lower"       : "Higher"
//     RomanNumeral:  attempt > password ? "ALTUS NIMIS" : "PARUM BREVIS"
// so in both cases the first form means the answer is below the guess.
//
// The old AccountsManager code parsed "Lower"/"Higher" correctly - it just read
// them off r.data, which is always undefined, so the interval never moved and
// every iteration recomputed the same midpoint. That was the "always 50".
// BellaCuore never got a solver at all; it went through the static path, which
// mis-decoded its range and then had the guess truncated to the password
// length, which is where the endlessly repeated "16" came from.
//
// If heartbleed can't be read (charisma gate, server drifted out of direct
// connection), each guess still gets consumed, so the search degrades to a
// blind sweep of the range instead of spinning.
async function authHiLo(ns, dnet, hostname, entry, details, label) {
    if (!entry._amPool || !entry._amPool.length) {
        entry._amPool = hiLoPool(details);
        ns.print(`${hostname}: ${label} searching ${entry._amPool.length} value(s) in [${entry._amPool[0]}, ${entry._amPool[entry._amPool.length - 1]}]`);
    }

    const rounds = Math.min(12, entry._amPool.length);
    for (let i = 0; i < rounds; i++) {
        if (!entry._amPool.length) break;
        const guess = entry._amPool[Math.floor(entry._amPool.length / 2)];
        // The generator stores the password as String(n) with no padding, so
        // send it unpadded - "05" is never the answer on a length-2 server.
        const pw = String(guess);
        let r;
        try {
            r = await dnet.authenticate(hostname, pw);
        } catch (e) {
            ns.print(`auth ${hostname} error: ${e?.message || e}`);
            return false;
        }
        if (r && r.success) {
            entry.password = pw;
            entry.session = true;
            delete entry._amPool; delete entry._amBlind;
            ns.print(`auth ${hostname} SUCCESS: ${pw}`);
            return true;
        }

        const dir = hiLoDirection(await readAuthFeedback(ns, dnet, hostname, pw));
        if (dir < 0) entry._amPool = entry._amPool.filter(n => n < guess);
        else if (dir > 0) entry._amPool = entry._amPool.filter(n => n > guess);
        else {
            // Consume the guess regardless - this is what stops a spin.
            entry._amPool = entry._amPool.filter(n => n !== guess);
            if (!entry._amBlind) {
                entry._amBlind = true;
                ns.print(`${hostname}: ${label} got no heartbleed feedback (cha ${details.requiredCharismaSkill ?? '?'} req), sweeping ${entry._amPool.length + 1}`);
            }
        }
        await ns.sleep(50);
    }
    if (!entry._amPool.length) {
        ns.print(`auth ${hostname}: ${label} range exhausted, rebuilding`);
        delete entry._amPool; delete entry._amBlind;
    }
    return false;
}

// RateMyPix.Auth (upstream SpiceLevel) - "bulls-only" Mastermind.
//
// Feedback is one chilli per character that is in exactly the right position,
// then the length: "🌶️🌶️/5" means 2 of 5 positions correct, "0/5" means none.
// Crucially the chillis are concatenated with no separator, so the response
// carries a COUNT and nothing about which positions matched.
//
// The old crackers.js branch counted chillis in `details.data` and returned
// that count as the password. Two things wrong with it: the chilli count is
// per-attempt feedback, not a property of the server, and SpiceLevel sets no
// passwordHintData at all - its only static hint is the literal string
// "!!🌶️!!" - so `data` is always "" and it always guessed "0".repeat(len).
//
// Solved in three phases. With a null character - one the password does not
// contain - a probe of nullChar.repeat(len) with a subset S of positions set
// to c scores exactly |{i in S : password[i] === c}|, because the null
// character contributes nothing outside S. That turns the oracle into a
// counting query over any position set, which binary splitting resolves in
// about len*log2(len) probes instead of len*|alphabet|.
//
//   1. Composition: probe c.repeat(len) for each c in the alphabet. The score
//      is how many positions hold c. Stop as soon as the counts sum to len;
//      any character not reached has a count of zero. This also picks up the
//      null character for free, and outright wins if the password is all one
//      character.
//   2. Placement: for each character present (skipping the most frequent one -
//      its positions are whatever is left over), binary-split the unresolved
//      positions to find where its instances sit.
//   3. Assemble and authenticate.
//
// The alphabet comes from passwordFormat, which upstream derives from the
// actual password, so "numeric" is a sound restriction to 10 characters rather
// than a guess. getSpiceLevelConfig only allows letters when difficulty > 8.
const BULLS_DIGITS = '0123456789';
const BULLS_LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
// Probes per cycle. Each is an authenticate() plus a heartbleed(), so this
// caps how long one host can monopolise the worm's loop; state persists in
// `entry`, so the solve resumes on the next pass.
const BULLS_PROBES_PER_CYCLE = 25;

// Both RateMyPix.Auth and DeepGreen expose the same underlying oracle, so they
// share this solver; only the scoring differs (see BULLS_MODELS).
//   RateMyPix.Auth  "🌶️🌶️/5"  -> 2 characters in exactly the right place
//   DeepGreen       "2,1"      -> 2 exact, 1 present but misplaced
// DeepGreen's misplaced count is extra information this doesn't need: a probe
// of c.repeat(len) always scores 0 misplaced (every non-exact guess character
// is c, and c is by construction absent from the unmatched remainder), so the
// exact count alone is the same composition oracle. The null-character mask
// then makes it a subset-counting oracle, and binary splitting does the rest.
async function authBullsOracle(ns, dnet, hostname, entry, details, cfg) {
    const len = details.passwordLength || 1;
    if (!entry._bo || entry._bo.len !== len) {
        entry._bo = newBullsState(details, len);
        ns.print(`${hostname}: ${cfg.label} len ${len} ${details.passwordFormat || '?'}, ${entry._bo.alpha.length}-char alphabet`);
    }
    const st = entry._bo;

    for (let budget = BULLS_PROBES_PER_CYCLE; budget > 0; budget--) {
        // Phase 1: character composition.
        if (!st.placing) {
            if (st.found < len && st.idx < st.alpha.length) {
                const c = st.alpha[st.idx];
                const p = await bullsProbe(ns, dnet, hostname, entry, c.repeat(len), cfg);
                if (p.solved) return true;
                // Only advance once the score is actually in hand. Advancing
                // first would drop this character's count on an unreadable
                // response, leaving a composition that never sums to len and
                // deducing a password from incomplete counts.
                if (p.count == null) return noFeedback(ns, st, hostname, cfg.label);
                st.idx++;
                if (p.count > 0) { st.counts[c] = p.count; st.found += p.count; }
                else if (st.nullChar === null) st.nullChar = c;
                continue;
            }
            if (!beginBullsPlacement(ns, st, hostname, len, cfg)) {
                delete entry._bo;
                return false;
            }
        }

        // Phase 2: locate each character's positions by binary splitting.
        if (st.tasks.length) {
            const t = st.tasks[0];
            if (t.k === 0) { st.tasks.shift(); continue; }
            if (t.k === t.pos.length) {
                for (const i of t.pos) st.known[i] = t.c;
                st.tasks.shift();
                continue;
            }
            const half = Math.floor(t.pos.length / 2);
            const a = t.pos.slice(0, half), b = t.pos.slice(half);
            const p = await bullsProbe(ns, dnet, hostname, entry, bullsMask(st, len, a, t.c), cfg);
            if (p.solved) return true;
            if (p.count == null) return noFeedback(ns, st, hostname, cfg.label);
            st.tasks.shift();
            st.tasks.push({ c: t.c, k: p.count, pos: a }, { c: t.c, k: t.k - p.count, pos: b });
            continue;
        }
        if (st.pending.length) {
            const c = st.pending.shift();
            st.tasks = [{ c, k: st.counts[c], pos: bullsUnknown(st, len) }];
            continue;
        }

        // Phase 3: everything still unresolved belongs to the skipped character.
        for (let i = 0; i < len; i++) if (st.known[i] === null) st.known[i] = st.fill;
        const pw = st.known.join('');
        const p = await bullsProbe(ns, dnet, hostname, entry, pw, cfg);
        if (p.solved) return true;
        // Only reachable if a probe was scored against a password that changed
        // mid-solve. Start over rather than loop on a stale deduction.
        ns.print(`auth ${hostname}: ${cfg.label} deduced ${pw} but it was rejected, restarting`);
        delete entry._bo;
        return false;
    }
    return false;
}

// passwordFormat is derived upstream from the actual password, so restricting
// to the reported class is sound rather than a guess.
function bullsAlphabet(details) {
    const fmt = details.passwordFormat;
    return fmt === 'numeric' ? BULLS_DIGITS
        : fmt === 'alphabetic' ? BULLS_LETTERS
        : BULLS_DIGITS + BULLS_LETTERS;
}

function newBullsState(details, len) {
    const alpha = bullsAlphabet(details);
    return {
        len, alpha,
        idx: 0,             // next alphabet index to probe
        counts: {},         // character -> how many positions hold it
        found: 0,           // sum of counts so far
        nullChar: null,     // a character known absent from the password
        known: new Array(len).fill(null),
        placing: false,
        pending: [],        // characters still to locate
        tasks: [],          // {c, k, pos} - k instances of c somewhere in pos
        fill: null,         // character whose positions are inferred, not probed
    };
}

// Transitions from composition to placement. Returns false if the scan came up
// empty, which means the password uses characters outside the alphabet we
// derived from passwordFormat.
function beginBullsPlacement(ns, st, hostname, len, cfg) {
    const present = Object.keys(st.counts);
    if (!present.length) {
        ns.print(`auth ${hostname}: ${cfg.label} found no characters in ${st.alpha.length}-char alphabet, giving up`);
        return false;
    }
    if (st.nullChar === null) {
        // Every probed character scored, so take one we never reached; a
        // password shorter than the alphabet always leaves one.
        st.nullChar = st.alpha.split('').find(c => !(c in st.counts));
        if (st.nullChar == null) {
            ns.print(`auth ${hostname}: ${cfg.label} has no unused character to mask with, giving up`);
            return false;
        }
    }
    // Skip the most frequent character - the positions no other character
    // claims are its by elimination, which saves its whole binary split.
    present.sort((a, b) => st.counts[b] - st.counts[a]);
    st.fill = present.shift();
    st.pending = present;
    st.placing = true;
    return true;
}

// nullChar everywhere except `positions`, which get `c`. Positions outside the
// set score nothing because nullChar is absent from the password, so the
// result is purely the count of `c` inside the set.
function bullsMask(st, len, positions, c) {
    const out = new Array(len).fill(st.nullChar);
    for (const i of positions) out[i] = c;
    return out.join('');
}

function bullsUnknown(st, len) {
    const out = [];
    for (let i = 0; i < len; i++) if (st.known[i] === null) out.push(i);
    return out;
}

// One attempt plus the heartbleed read of its score.
// Returns {solved} on success, {count} otherwise - count is null when the
// feedback couldn't be read, which tells the caller to stop for this cycle
// rather than treat "unknown" as "zero" and deduce garbage.
async function bullsProbe(ns, dnet, hostname, entry, pw, cfg) {
    let r;
    try {
        r = await dnet.authenticate(hostname, pw);
    } catch (e) {
        ns.print(`auth ${hostname} error: ${e?.message || e}`);
        return { solved: false, count: null };
    }
    if (r && r.success) {
        entry.password = pw;
        entry.session = true;
        delete entry._bo;
        ns.print(`auth ${hostname} SUCCESS: ${pw}`);
        return { solved: true, count: null };
    }
    return { solved: false, count: cfg.parse(await readAuthFeedback(ns, dnet, hostname, pw)) };
}

// "🌶️🌶️/5" -> 2, "0/5" -> 0. Iterating yields code points, so the variation
// selector trailing each chilli doesn't inflate the count.
const BULLS_MODELS = {
    'RateMyPix.Auth': { label: 'RateMyPix', parse: spiceCount },
    'DeepGreen': { label: 'DeepGreen', parse: mastermindExact },
};

// "2,1" -> 2 exact matches. Upstream builds this as `${exact},${misplaced}`.
function mastermindExact(fb) {
    if (typeof fb !== 'string') return null;
    const n = parseInt(fb.split(',')[0], 10);
    return Number.isFinite(n) ? n : null;
}

function spiceCount(fb) {
    if (typeof fb !== 'string') return null;
    const head = fb.split('/')[0];
    if (head === '0') return 0;
    let n = 0;
    for (const ch of head) if (ch === '🌶') n++;
    return n;
}

// -1 if the response says the password is below the guess, +1 if above, 0 if
// unreadable. Both vocabularies are recognised; the substring fallbacks cover
// the wording gaining decoration.
function hiLoDirection(fb) {
    if (typeof fb !== 'string') return 0;
    const t = fb.trim().toUpperCase();
    if (t === 'LOWER' || t === 'ALTUS NIMIS') return -1;
    if (t === 'HIGHER' || t === 'PARUM BREVIS') return 1;
    if (t.includes('ALTUS') || t.includes('LOWER')) return -1;
    if (t.includes('BREVIS') || t.includes('HIGHER')) return 1;
    return 0;
}

// Every value the password could take.
//
// The digit count always bounds it: getGuessNumberConfig writes the password
// as String(Math.floor(...)) and getRomanNumeralConfig as `${password}`, so
// neither is zero-padded and a length-L password is a plain L-digit decimal -
// 0-9 for L=1, 10-99 for L=2. That alone rules out the zero-padded low end.
//
// BellaCuore narrows it further at difficulty 8 and up, where passwordHintData
// carries an explicit "encodedMin,encodedMax" range. Intersecting the two is
// what turns "between nulla and LXVIII" at length 2 into 10..68 - 59 values,
// six probes of binary search.
function hiLoPool(details) {
    const l = Math.min(Math.max(details.passwordLength || 1, 1), 6);
    let lo = l === 1 ? 0 : Math.pow(10, l - 1);
    let hi = Math.pow(10, l) - 1;

    if (details.modelId === 'BellaCuore') {
        const parsed = romanHint(details.data, details.passwordHint);
        if (parsed && parsed.exact != null) {
            // Below difficulty 8 the hint IS the password, roman-encoded.
            return [parsed.exact];
        }
        if (parsed) {
            lo = Math.max(lo, parsed.lo);
            hi = Math.min(hi, parsed.hi);
        }
    }
    if (lo > hi) { lo = l === 1 ? 0 : Math.pow(10, l - 1); hi = Math.pow(10, l) - 1; }

    const pool = [];
    for (let n = lo; n <= hi; n++) pool.push(n);
    return pool;
}

// PHP 5.4 (upstream SortedEchoVuln). The hint hands over the password's digits
// already sorted, so the only unknown is the arrangement - and the failure data
// carries the root-mean-square deviation between the attempt and the password:
//
//     squaredError += (Number(att[i]) - Number(password[i])) ** 2
//     `${passwordHintData}; RMS Deviation:${Math.sqrt(se / len).toFixed(3)}`
//
// That is enough to read off each digit directly. Let E(a) = len * rmsd(a)^2 be
// the total squared error. Take a baseline B and change exactly one position i
// from b to d; only that term moves, so with x the true digit at i:
//
//     E' - E = (d - x)^2 - (b - x)^2 = (d^2 - b^2) + 2x(b - d)
//        =>   x = (E' - E - d^2 + b^2) / (2 * (b - d))
//
// One baseline probe plus one probe per position solves it outright: len + 1
// reads regardless of length, instead of walking permutations. d is chosen far
// from b so the division by (b - d) suppresses the rounding in toFixed(3).
//
// Below length 5 upstream returns no deviation at all (checkPassword bails on
// `password.length < 5`), but the permutation count there is at most 24, so
// that case just enumerates. The old static path enumerated in every case,
// which is why 5-digit servers sat at a 64% solve rate - 120 permutations
// against the caller's 60-attempt cap.
const SORTED_ECHO_PROBES_PER_CYCLE = 25;

async function authSortedEcho(ns, dnet, hostname, entry, details) {
    const len = details.passwordLength || 1;
    if (!entry._se || entry._se.len !== len) {
        const digits = String(details.data || details.passwordHint || '').replace(/[^0-9]/g, '').slice(-len);
        entry._se = { len, digits, base: null, E0: null, pos: 0, out: new Array(len).fill(null), perms: null, idx: 0 };
        ns.print(`${hostname}: PHP 5.4 len ${len}, digits ${digits || '?'}, ${len >= 5 ? 'RMS deviation solve' : 'permutations'}`);
    }
    const st = entry._se;
    if (st.digits.length !== len) {
        ns.print(`auth ${hostname}: PHP 5.4 hint has ${st.digits.length} digits, expected ${len}, giving up`);
        delete entry._se;
        return false;
    }

    for (let budget = SORTED_ECHO_PROBES_PER_CYCLE; budget > 0; budget--) {
        // Short passwords get no deviation reported, so enumerate instead.
        if (len < 5 || st.perms) {
            if (!st.perms) st.perms = [...new Set(permute(st.digits))].filter(x => x[0] !== '0' || len === 1);
            if (st.idx >= st.perms.length) {
                ns.print(`auth ${hostname}: PHP 5.4 exhausted ${st.perms.length} permutations, restarting`);
                delete entry._se;
                return false;
            }
            const r = await sortedEchoProbe(ns, dnet, hostname, entry, st.perms[st.idx++]);
            if (r.solved) return true;
            if (r.rmsd === undefined) return false;
            continue;
        }

        if (st.E0 == null) {
            st.base = st.digits;
            const r = await sortedEchoProbe(ns, dnet, hostname, entry, st.base);
            if (r.solved) return true;
            if (r.rmsd == null) return noFeedback(ns, st, hostname, 'PHP 5.4');
            st.E0 = len * r.rmsd * r.rmsd;
            continue;
        }

        if (st.pos < len) {
            const b = Number(st.base[st.pos]);
            // Pick the probe digit as far from the baseline as possible: the
            // solved x divides by (b - d), so a large gap damps the 3-decimal
            // rounding on the reported deviation.
            const d = b < 5 ? 9 : 0;
            const probe = st.base.slice(0, st.pos) + String(d) + st.base.slice(st.pos + 1);
            const r = await sortedEchoProbe(ns, dnet, hostname, entry, probe);
            if (r.solved) return true;
            if (r.rmsd == null) return noFeedback(ns, st, hostname, 'PHP 5.4');
            const E = len * r.rmsd * r.rmsd;
            const x = (E - st.E0 - d * d + b * b) / (2 * (b - d));
            st.out[st.pos] = Math.min(9, Math.max(0, Math.round(x)));
            st.pos++;
            continue;
        }

        const pw = st.out.join('');
        // The deduced digits must be a rearrangement of the ones we were given;
        // if not, the algebra drifted and permutations are the safer fallback.
        if (pw.split('').sort().join('') !== st.digits.split('').sort().join('')) {
            ns.print(`auth ${hostname}: PHP 5.4 deduced ${pw}, not a permutation of ${st.digits} - falling back to enumeration`);
            st.perms = null; st.idx = 0;
            continue;
        }
        const r = await sortedEchoProbe(ns, dnet, hostname, entry, pw);
        if (r.solved) return true;
        ns.print(`auth ${hostname}: PHP 5.4 deduced ${pw} but it was rejected - falling back to enumeration`);
        st.perms = null; st.idx = 0;
    }
    return false;
}

async function sortedEchoProbe(ns, dnet, hostname, entry, pw) {
    let r;
    try {
        r = await dnet.authenticate(hostname, pw);
    } catch (e) {
        ns.print(`auth ${hostname} error: ${e?.message || e}`);
        return { solved: false, rmsd: undefined };
    }
    if (r && r.success) {
        entry.password = pw;
        entry.session = true;
        delete entry._se;
        ns.print(`auth ${hostname} SUCCESS: ${pw}`);
        return { solved: true, rmsd: null };
    }
    const fb = await readAuthFeedback(ns, dnet, hostname, pw);
    const m = typeof fb === 'string' ? fb.match(/RMS Deviation:\s*([0-9.]+)/i) : null;
    return { solved: false, rmsd: m ? parseFloat(m[1]) : null };
}

// 2G_cellular (upstream TimingAttack) - a prefix oracle handed over in plain
// text.
//
//   const indexOfDifference = server.password.split("")
//       .findIndex((char, i) => char !== attemptedPassword[i]);
//   const hint = `Found a mismatch while checking each character (${indexOfDifference})`;
//
// Every attempt reports the index of the FIRST wrong character, so the password
// builds left to right: hold a known-good prefix, try each alphabet character
// in the next slot, and whichever one pushes the reported index past that slot
// is correct.
//
// The index arrives in `message`, not `data`. `data` carries the response time
// - the side channel the model is named for, which leaks the same prefix length
// through calculateAuthenticationTime(..., getSharedChars(...)) - but the
// message is exact, so there's no need to time anything.
//
// A filler character occupies the unknown tail. When the filler happens to
// match positions beyond the one being solved, the reported index jumps past
// them and confirms several characters at once, so the new prefix is
// guess.slice(0, index) rather than just one character appended.
//
// The old static branch returned "0".repeat(len): one candidate, re-sent
// unchanged every cycle forever.
const TIMING_PROBES_PER_CYCLE = 25;

async function authTimingAttack(ns, dnet, hostname, entry, details) {
    const len = details.passwordLength || 1;
    if (!entry._ta || entry._ta.len !== len) {
        entry._ta = { len, alpha: bullsAlphabet(details), prefix: '', idx: 0 };
        ns.print(`${hostname}: 2G_cellular len ${len} ${details.passwordFormat || '?'}, prefix oracle over ${entry._ta.alpha.length} chars`);
    }
    const st = entry._ta;
    const fill = st.alpha[0];

    for (let budget = TIMING_PROBES_PER_CYCLE; budget > 0; budget--) {
        const at = st.prefix.length;
        if (at >= len || st.idx >= st.alpha.length) {
            // Solving the last position wins outright (the guess equals the
            // password), so reaching either of these means the prefix went
            // stale under us - most likely the password was regenerated.
            ns.print(`auth ${hostname}: 2G_cellular stuck at position ${at} of ${len}, restarting`);
            delete entry._ta;
            return false;
        }

        const guess = st.prefix + st.alpha[st.idx] + fill.repeat(len - at - 1);
        let r;
        try {
            r = await dnet.authenticate(hostname, guess);
        } catch (e) {
            ns.print(`auth ${hostname} error: ${e?.message || e}`);
            return false;
        }
        if (r && r.success) {
            entry.password = guess;
            entry.session = true;
            delete entry._ta;
            ns.print(`auth ${hostname} SUCCESS: ${guess}`);
            return true;
        }

        const o = await readAuthEntry(ns, dnet, hostname, guess);
        const mismatch = timingMismatchIndex(o?.message);
        if (mismatch == null) return noFeedback(ns, st, hostname, '2G_cellular');

        if (mismatch > at) {
            // Everything before the reported mismatch is confirmed, which can
            // be more than the single character we were testing.
            st.prefix = guess.slice(0, mismatch);
            st.idx = 0;
        } else if (mismatch === at) {
            st.idx++;
        } else {
            ns.print(`auth ${hostname}: 2G_cellular prefix invalidated at ${mismatch}, restarting`);
            delete entry._ta;
            return false;
        }
    }
    return false;
}

// "Found a mismatch while checking each character (3)" -> 3
function timingMismatchIndex(msg) {
    if (typeof msg !== 'string') return null;
    const m = msg.match(/\((-?\d+)\)/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
}

// NIL (upstream Yesn_t) - positional feedback, the most generous oracle here.
//
//   attemptedPassword.split("").map((c, i) => c === password[i] ? "yes" : "yesn't").join(",")
//
// So a probe of c.repeat(len) names EVERY position holding c in one shot -
// no binary splitting needed, unlike the bulls-only models. Sweep the alphabet
// and the password falls out in at most |alphabet| probes.
//
// The old solver had the right shape but read the response off r.data, which
// is undefined, so it never locked a position; it then walked _nilDigit to 10,
// reset, and looped forever. It was also digit-only, while getYesn_tConfig
// allows letters above difficulty 8.
const NIL_PROBES_PER_CYCLE = 25;

async function authNIL(ns, dnet, hostname, entry, details) {
    const len = details.passwordLength || 1;
    if (!entry._nil || entry._nil.len !== len) {
        entry._nil = {
            len,
            alpha: bullsAlphabet(details),
            idx: 0,
            known: new Array(len).fill(null),
        };
        ns.print(`${hostname}: NIL len ${len} ${details.passwordFormat || '?'}, ${entry._nil.alpha.length}-char alphabet`);
    }
    const st = entry._nil;

    for (let budget = NIL_PROBES_PER_CYCLE; budget > 0; budget--) {
        const unknown = st.known.filter(c => c === null).length;

        // Whatever the final unprobed character is, it must own every position
        // still unaccounted for - no need to spend a probe confirming it.
        if (unknown && st.idx === st.alpha.length - 1) {
            const last = st.alpha[st.idx];
            for (let i = 0; i < len; i++) if (st.known[i] === null) st.known[i] = last;
            st.idx++;
            continue;
        }
        if (!unknown) {
            const pw = st.known.join('');
            const r = await nilProbe(ns, dnet, hostname, entry, pw);
            if (r.solved) return true;
            ns.print(`auth ${hostname}: NIL deduced ${pw} but it was rejected, restarting`);
            delete entry._nil;
            return false;
        }
        if (st.idx >= st.alpha.length) {
            ns.print(`auth ${hostname}: NIL exhausted its alphabet with ${unknown} positions unresolved, restarting`);
            delete entry._nil;
            return false;
        }

        const c = st.alpha[st.idx];
        const r = await nilProbe(ns, dnet, hostname, entry, c.repeat(len));
        if (r.solved) return true;
        if (r.marks == null) return noFeedback(ns, st, hostname, 'NIL');
        st.idx++;
        for (let i = 0; i < len && i < r.marks.length; i++) {
            // "yesn't" starts with "yes", so this has to be an exact match.
            if (r.marks[i].trim() === 'yes') st.known[i] = c;
        }
    }
    return false;
}

async function nilProbe(ns, dnet, hostname, entry, pw) {
    let r;
    try {
        r = await dnet.authenticate(hostname, pw);
    } catch (e) {
        ns.print(`auth ${hostname} error: ${e?.message || e}`);
        return { solved: false, marks: null };
    }
    if (r && r.success) {
        entry.password = pw;
        entry.session = true;
        delete entry._nil;
        ns.print(`auth ${hostname} SUCCESS: ${pw}`);
        return { solved: true, marks: null };
    }
    const fb = await readAuthFeedback(ns, dnet, hostname, pw);
    return { solved: false, marks: typeof fb === 'string' ? fb.split(',') : null };
}

// OpenWebAccessPoint (upstream packetSniffer) - the response IS the leak.
//
// checkPassword hands this model's failure data straight to capturePackets(),
// which splices the password into a wall of noise:
//
//   difficulty <= 16:  ` ${hostname}:${password} ` inside chatty log text
//   difficulty >  16:  the raw password, no delimiter, buried in ~124-144
//                      characters of random alphanumeric junk
//
// The easy form is a regex. The hard form carries no marker, but every
// substring of the right length is a candidate - and because each failed
// attempt returns a FRESH capture with fresh noise, intersecting the candidate
// sets across two or three captures leaves only the password, which is the one
// string present in all of them.
//
// The old solver read heartbleed's ambient log noise instead and scraped
// "I can see a X and a Y" hints out of it to build digit permutations. Those
// phrases come from getLogNoise(), a different generator, and leak two
// characters of a password that may not even be this server's. It never looked
// at the packet dump the oracle was handing it directly.
const OPENWEB_PROBES_PER_CYCLE = 12;
// Below this many candidates, spend the probe on a real attempt rather than a
// throwaway - it might just win, and it yields a capture either way.
const OPENWEB_DIRECT_TRIES = 8;

async function authOpenWeb(ns, dnet, hostname, entry, details) {
    const len = details.passwordLength || 1;
    if (!entry._ow || entry._ow.len !== len) {
        entry._ow = { len, candidates: null, captures: 0 };
        ns.print(`${hostname}: OpenWebAccessPoint len ${len}, reading packet captures`);
    }
    const st = entry._ow;

    for (let budget = OPENWEB_PROBES_PER_CYCLE; budget > 0; budget--) {
        const narrowed = st.candidates && st.candidates.length && st.candidates.length <= OPENWEB_DIRECT_TRIES;
        const pw = narrowed ? st.candidates.shift() : 'a'.repeat(len);

        let r;
        try {
            r = await dnet.authenticate(hostname, pw);
        } catch (e) {
            ns.print(`auth ${hostname} error: ${e?.message || e}`);
            return false;
        }
        if (r && r.success) {
            entry.password = pw;
            entry.session = true;
            delete entry._ow;
            ns.print(`auth ${hostname} SUCCESS: ${pw}`);
            return true;
        }

        const packet = await readAuthFeedback(ns, dnet, hostname, pw);
        if (packet == null) return noFeedback(ns, st, hostname, 'OpenWebAccessPoint');
        st.captures++;

        // Easy form: the password is labelled with the server's own hostname.
        const direct = owDirect(packet, hostname, len);
        if (direct) { st.candidates = [direct]; continue; }

        // Hard form: intersect this capture's substrings with what survived.
        const seen = owSubstrings(packet, len);
        st.candidates = st.candidates ? st.candidates.filter(c => seen.has(c)) : [...seen];
        if (!st.candidates.length) {
            // The password is in every capture, so an empty set means the
            // password changed under us. Start over rather than spin.
            ns.print(`auth ${hostname}: OpenWebAccessPoint candidates collapsed after ${st.captures} captures, restarting`);
            delete entry._ow;
            return false;
        }
    }
    return false;
}

function owDirect(packet, hostname, len) {
    const esc = String(hostname).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Anchored on our own hostname first. The trailing guard keeps it from
    // matching a prefix of something longer.
    let m = packet.match(new RegExp(esc + ':([0-9A-Za-z]{' + len + '})(?![0-9A-Za-z])'));
    if (m) return m[1];
    // Fall back to any host:secret pair of the right length, in case we were
    // handed an IP rather than the hostname the packet was written with.
    m = packet.match(new RegExp('[\\w.-]+:([0-9A-Za-z]{' + len + '})(?![0-9A-Za-z])'));
    return m ? m[1] : null;
}

function owSubstrings(packet, len) {
    const out = new Set();
    for (let i = 0; i + len <= packet.length; i++) out.add(packet.slice(i, i + len));
    return out;
}

// Factori-Os (upstream divisibilityTest) - a divisibility oracle.
//
// Send any number n and the response says whether n divides the password:
// data "true"/"false", message "Password IS/is not divisible by 'n'". Same
// story as every other model - that only reaches a script through
// heartbleed(), never through authenticate()'s return - so the old solver's
// `if (r.data !== 'true') continue;` was false on every prime. It skipped all
// 30, left _foIdx past the end of its list, and then did nothing at all on
// every subsequent call.
//
// The algorithm was also wrong independently of the feedback bug. It walked a
// hardcoded list of the first 30 primes, which misses the large primes
// upstream multiplies in above difficulty 12, and it never used the known
// password length to bound anything.
//
// getPasswordMadeUpOfPrimesProduct builds the password as
//     base * (scale/3 factors) * [largePrime] * [largePrime]
// with base <= 80, the inner factors drawn from smallPrimes or 1..5, and the
// large primes only above difficulty 12 and 24. Every prime factor therefore
// comes from a known 108-entry universe - these two lists, copied from
// upstream - so this is a bounded sweep, not a search.
//
// Primes are taken in ascending order with each exponent resolved before
// moving on, so the unfactored remainder never has a factor below the current
// prime. That gives a strong stopping rule: once product * p exceeds the
// largest number of the password's digit length, the remainder must be 1 and
// the factorisation is complete. On a 3-digit password that kills the entire
// large-prime list on the first comparison, since 1069 alone already overflows.
const FACTORI_SMALL_PRIMES = [
    2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97,
];
const FACTORI_LARGE_PRIMES = [
    1069, 1409, 1471, 1567, 1597, 1601, 1697, 1747, 1801, 1889, 1979, 1999, 2063, 2207, 2371, 2503, 2539, 2693, 2741,
    2753, 2801, 2819, 2837, 2909, 2939, 3169, 3389, 3571, 3761, 3881, 4217, 4289, 4547, 4729, 4789, 4877, 4943, 4951,
    4957, 5393, 5417, 5419, 5441, 5519, 5527, 5647, 5779, 5881, 6007, 6089, 6133, 6389, 6451, 6469, 6547, 6661, 6719,
    6841, 7103, 7549, 7559, 7573, 7691, 7753, 7867, 8053, 8081, 8221, 8329, 8599, 8677, 8761, 8839, 8963, 9103, 9199,
    9343, 9467, 9551, 9601, 9739, 9749, 9859,
];
const FACTORI_PROBES_PER_CYCLE = 25;

async function authFactoriOs(ns, dnet, hostname, entry, details) {
    const len = details.passwordLength || 1;
    if (!entry._fo || entry._fo.len !== len) {
        entry._fo = {
            len,
            // BigInt throughout: upstream only rejects a generated password if
            // it doesn't round-trip through Number, which still admits values
            // above MAX_SAFE_INTEGER (17 digits shows up by difficulty 26).
            // Accumulating the product in doubles silently corrupts those.
            maxVal: 10n ** BigInt(len) - 1n,
            product: 1n,    // fully resolved factors so far
            large: false,   // which prime list we're sweeping
            idx: 0,
            exp: 0,         // confirmed exponent of the current prime
        };
        ns.print(`${hostname}: Factori-Os len ${len}, factoring via divisibility oracle`);
    }
    const st = entry._fo;

    for (let budget = FACTORI_PROBES_PER_CYCLE; budget > 0; budget--) {
        const primes = st.large ? FACTORI_LARGE_PRIMES : FACTORI_SMALL_PRIMES;
        // Only safe to conclude between primes, not mid-exponent-walk.
        const done = st.idx >= primes.length
            || (st.exp === 0 && st.product * BigInt(primes[st.idx]) > st.maxVal);
        if (done) {
            if (st.large) return await factoriVerify(ns, dnet, hostname, entry, st);
            st.large = true; st.idx = 0; st.exp = 0;
            continue;
        }

        const p = BigInt(primes[st.idx]);
        const q = p ** BigInt(st.exp + 1);
        // password = product * remainder, and p does not divide product, so if
        // p^(exp+1) divides the password then the password is at least
        // product * p^(exp+1). Bounding against the product rather than
        // against maxVal alone is what keeps the exponent walk short - on a
        // 17-digit password the loose version burned ~1400 probes walking
        // 2^1..2^57 and friends.
        if (st.product * q > st.maxVal) {
            st.product *= p ** BigInt(st.exp);
            st.idx++; st.exp = 0;
            continue;
        }

        const res = await factoriProbe(ns, dnet, hostname, entry, q);
        if (res.solved) return true;
        if (res.divides == null) return noFeedback(ns, st, hostname, 'Factori-Os');
        if (res.divides) { st.exp++; continue; }
        st.product *= p ** BigInt(st.exp);
        st.idx++; st.exp = 0;
    }
    return false;
}

async function factoriVerify(ns, dnet, hostname, entry, st) {
    const pw = st.product.toString();
    if (pw.length !== st.len) {
        // The product doesn't have the advertised digit count, so the password
        // has a factor outside both upstream lists. Bail loudly rather than
        // hammer a number that can't be right.
        ns.print(`auth ${hostname}: Factori-Os factored to ${pw} (${pw.length} digits, expected ${st.len}) - factor outside the known primes, giving up`);
        delete entry._fo;
        return false;
    }
    const res = await factoriProbe(ns, dnet, hostname, entry, st.product);
    if (res.solved) return true;
    ns.print(`auth ${hostname}: Factori-Os deduced ${pw} but it was rejected, restarting`);
    delete entry._fo;
    return false;
}

// Asks whether `n` divides the password. Note that a probe can win outright:
// checkPassword() tests equality before it ever reaches the divisibility
// branch, so probing a divisor that happens to BE the password authenticates.
async function factoriProbe(ns, dnet, hostname, entry, n) {
    const q = String(n);
    let r;
    try {
        r = await dnet.authenticate(hostname, q);
    } catch (e) {
        ns.print(`auth ${hostname} error: ${e?.message || e}`);
        return { solved: false, divides: null };
    }
    if (r && r.success) {
        entry.password = q;
        entry.session = true;
        delete entry._fo;
        ns.print(`auth ${hostname} SUCCESS: ${q}`);
        return { solved: true, divides: null };
    }
    const o = await readAuthEntry(ns, dnet, hostname, q);
    const fb = o ? String(o.data) : null;
    if (fb === 'true') return { solved: false, divides: true };
    if (fb === 'false') return { solved: false, divides: false };
    // Fall back to the prose if `data` ever stops being a bare boolean string.
    const msg = typeof o?.message === 'string' ? o.message : '';
    if (/\bis divisible\b/i.test(msg)) return { solved: false, divides: true };
    if (/\bnot divisible\b/i.test(msg)) return { solved: false, divides: false };
    return { solved: false, divides: null };
}

// BigMo%od (upstream tripleModulo). The response is
//     (password % n) % (((n - 1) % 32) + 1)
// for whatever n you send. That inner modulus is the whole puzzle: for n <= 32
// it equals n exactly, so the outer mod is a no-op and the answer is a clean
// `password % n`. Above 32 it collapses - n = 33 gives an inner modulus of 1,
// i.e. always 0 - so every useful probe lives at n <= 32.
//
// Take residues against pairwise-coprime prime powers <= 32 and reconstruct
// with the Chinese Remainder Theorem. Their full product is ~1.4e14, well past
// the 11 digits getTripleModuloConfig can produce, so 9-11 probes is the whole
// solve.
//
// The old version was broken three ways over: it read r.data (undefined, so
// every residue was NaN and the moduli product never grew), it walked n = 2,
// 3, 4, 5... which are not pairwise coprime and make CRT invalid, and it did
// the reconstruction in doubles where the intermediate terms overflow
// MAX_SAFE_INTEGER.
const BIGMOD_MODULI = [32, 27, 25, 7, 11, 13, 17, 19, 23, 29, 31];
const BIGMOD_PROBES_PER_CYCLE = 15;

async function authBigMod(ns, dnet, hostname, entry, details) {
    const len = details.passwordLength || 1;
    if (!entry._bm || entry._bm.len !== len) {
        entry._bm = { len, maxVal: 10n ** BigInt(len) - 1n, rems: [], idx: 0 };
        ns.print(`${hostname}: BigMo%od len ${len}, CRT over moduli <= 32`);
    }
    const st = entry._bm;

    for (let budget = BIGMOD_PROBES_PER_CYCLE; budget > 0; budget--) {
        let product = 1n;
        for (const e of st.rems) product *= BigInt(e.m);
        // Once the moduli product exceeds the largest value of this digit
        // length, the residues pin the password to exactly one candidate.
        if (product > st.maxVal || st.idx >= BIGMOD_MODULI.length) {
            return await bigModSolve(ns, dnet, hostname, entry, st, product);
        }

        const m = BIGMOD_MODULI[st.idx];
        let r;
        try {
            r = await dnet.authenticate(hostname, String(m));
        } catch (e) {
            ns.print(`auth ${hostname} error: ${e?.message || e}`);
            return false;
        }
        // A modulus can be the password outright on a short one.
        if (r && r.success) {
            entry.password = String(m);
            entry.session = true;
            delete entry._bm;
            ns.print(`auth ${hostname} SUCCESS: ${m}`);
            return true;
        }
        const fb = await readAuthFeedback(ns, dnet, hostname, String(m));
        const val = fb == null ? NaN : parseInt(fb, 10);
        if (!Number.isFinite(val)) return noFeedback(ns, st, hostname, 'BigMo%od');
        st.rems.push({ m, r: val });
        st.idx++;
    }
    return false;
}

async function bigModSolve(ns, dnet, hostname, entry, st, product) {
    if (!st.rems.length) { delete entry._bm; return false; }
    const x = crtCombine(st.rems);
    // If the moduli product never cleared maxVal we only know the password
    // modulo `product`, so walk the arithmetic progression x, x+M, x+2M...
    const candidates = [];
    for (let k = 0n; ; k++) {
        const c = x + k * product;
        if (c > st.maxVal) break;
        if (c.toString().length === st.len) candidates.push(c);
        if (candidates.length >= 20) break;
    }
    for (const c of candidates) {
        let r;
        try {
            r = await dnet.authenticate(hostname, c.toString());
        } catch (e) {
            ns.print(`auth ${hostname} error: ${e?.message || e}`);
            return false;
        }
        if (r && r.success) {
            entry.password = c.toString();
            entry.session = true;
            delete entry._bm;
            ns.print(`auth ${hostname} SUCCESS: ${c}`);
            return true;
        }
    }
    ns.print(`auth ${hostname}: BigMo%od CRT gave ${candidates.length} candidate(s), none accepted - restarting`);
    delete entry._bm;
    return false;
}

// Chinese Remainder Theorem over pairwise-coprime moduli, in BigInt because
// the mi * inv terms overflow a double well before the moduli product does.
function crtCombine(rems) {
    let M = 1n;
    for (const e of rems) M *= BigInt(e.m);
    let x = 0n;
    for (const e of rems) {
        const m = BigInt(e.m);
        const mi = M / m;
        x = (x + BigInt(e.r) * mi * modInverseBig(mi % m, m)) % M;
    }
    return ((x % M) + M) % M;
}

function modInverseBig(a, m) {
    let [r0, r1] = [((a % m) + m) % m, m];
    let [s0, s1] = [1n, 0n];
    while (r1 !== 0n) {
        const q = r0 / r1;
        [r0, r1] = [r1, r0 - q * r1];
        [s0, s1] = [s1, s0 - q * s1];
    }
    return ((s0 % m) + m) % m;
}

// KingOfTheHill (upstream globalMaxima). Every attempt reports an altitude on
// a landscape of Gaussian hills, with the password sitting on the tallest.
//
// The exploitable part is the proximity rule in getKingOfTheHillAltitude:
//
//     if (Math.abs((x - password) / password) < 0.03)
//         return getAltitudeGivenHillSpecs(x, password, 10000, width);
//
// Inside 3% of the password the side hills are dropped and the reading is a
// single clean Gaussian, height 10000, centred exactly on the answer:
//
//     altitude = 10000 * exp(-((x - password) / width)^2)
//
// That inverts. One reading inside the band gives the exact distance
//
//     |x - password| = width * sqrt(ln(10000 / altitude))
//
// leaving just two candidates, x - d and x + d. So this doesn't hill-climb at
// all: it scans until something lands in the band, then solves for the answer.
//
// The scan is geometric rather than linear because the band is a percentage.
// Stepping by 5% guarantees a probe within 3% of any password (worst case is
// the midpoint, sqrt(1.05) - 1 = 2.4%), which covers a whole decade in ~48
// probes regardless of how large the numbers get.
//
// `width` is 10^max(len-2, 0) + 1, straight from the source, and the old
// solver never used it - it coarse-scanned, fine-scanned, and compared
// altitudes, all against r.data, which was undefined. parseFloat(undefined) is
// NaN, `|| 0` made every altitude 0, and bestAlt never moved off 0.
const KOTH_SCAN_RATIO = 1.05;
const KOTH_PROBES_PER_CYCLE = 25;
const KOTH_BRUTE_FORCE_MAX = 200;

async function authKingOfTheHill(ns, dnet, hostname, entry, details) {
    const len = details.passwordLength || 1;
    if (!entry._koh || entry._koh.len !== len) {
        const lo = len === 1 ? 0 : Math.pow(10, len - 1);
        const hi = Math.pow(10, len) - 1;
        entry._koh = {
            len, lo, hi,
            width: Math.pow(10, Math.max(len - 2, 0)) + 1,
            x: lo,                       // next scan position
            scanning: hi - lo + 1 > KOTH_BRUTE_FORCE_MAX,
            candidates: [],              // inversion results, best-altitude first
            readings: [],                // {x, alt} from the scan
        };
        ns.print(`${hostname}: KingOfTheHill len ${len}, width ${entry._koh.width}, ${entry._koh.scanning ? 'geometric scan' : 'brute force'}`);
    }
    const st = entry._koh;

    for (let budget = KOTH_PROBES_PER_CYCLE; budget > 0; budget--) {
        // Small ranges are cheaper to walk than to scan-and-invert.
        if (!st.scanning && st.x <= st.hi) {
            const r = await kothProbe(ns, dnet, hostname, entry, st.x);
            st.x++;
            if (r.solved) return true;
            if (r.alt == null) return noFeedback(ns, st, hostname, 'KingOfTheHill');
            continue;
        }

        if (st.scanning && st.x <= st.hi) {
            const r = await kothProbe(ns, dnet, hostname, entry, st.x);
            if (r.solved) return true;
            if (r.alt == null) return noFeedback(ns, st, hostname, 'KingOfTheHill');
            if (r.alt > 0) st.readings.push({ x: st.x, alt: r.alt });
            const next = Math.ceil(st.x * KOTH_SCAN_RATIO);
            // A geometric step overshooting `hi` would leave the top of the
            // range unprobed - the last step of a 100..999 sweep jumps 963 to
            // 1012, and a password of 993 sits 3.02% from 963, just outside the
            // band. Land on `hi` instead. That always closes the gap: the
            // skipped span is under one 5% step, so nothing in it can be 3%
            // away from both endpoints at once.
            st.x = (next > st.hi && st.x < st.hi) ? st.hi : (next > st.x ? next : st.x + 1);
            if (st.x > st.hi) st.candidates = kothInvert(st);
            continue;
        }

        if (st.candidates.length) {
            const c = st.candidates.shift();
            const r = await kothProbe(ns, dnet, hostname, entry, c);
            if (r.solved) return true;
            if (r.alt == null) return noFeedback(ns, st, hostname, 'KingOfTheHill');
            continue;
        }

        ns.print(`auth ${hostname}: KingOfTheHill exhausted scan and ${st.readings.length} inversions, restarting`);
        delete entry._koh;
        return false;
    }
    return false;
}

// Turns each scan reading into the two positions it implies for the password,
// assuming that reading was taken inside the 3% band. Readings taken outside
// produce a distance inconsistent with being inside the band, which throws
// them out for free - no probe spent. Ordered by altitude, since the closest
// reading is the most likely to have actually been in the band.
function kothInvert(st) {
    const out = [];
    const seen = new Set();
    const byAlt = st.readings.slice().sort((a, b) => b.alt - a.alt);
    for (const { x, alt } of byAlt) {
        if (!(alt > 0) || alt > 10000) continue;
        const d = st.width * Math.sqrt(Math.log(10000 / alt));
        if (!Number.isFinite(d)) continue;
        for (const cand of [Math.round(x - d), Math.round(x + d), Math.floor(x - d), Math.ceil(x + d)]) {
            if (cand < st.lo || cand > st.hi || seen.has(cand)) continue;
            // Self-consistency: if x really was within 3% of the password, the
            // candidate it implies has to be within 3% of x too.
            if (Math.abs(cand - x) / cand >= 0.03) continue;
            seen.add(cand);
            out.push(cand);
        }
    }
    return out;
}

async function kothProbe(ns, dnet, hostname, entry, x) {
    const pw = String(x);
    let r;
    try {
        r = await dnet.authenticate(hostname, pw);
    } catch (e) {
        ns.print(`auth ${hostname} error: ${e?.message || e}`);
        return { solved: false, alt: null };
    }
    if (r && r.success) {
        entry.password = pw;
        entry.session = true;
        delete entry._koh;
        ns.print(`auth ${hostname} SUCCESS: ${pw}`);
        return { solved: true, alt: null };
    }
    const fb = await readAuthFeedback(ns, dnet, hostname, pw);
    const alt = fb == null ? NaN : parseFloat(fb);
    return { solved: false, alt: Number.isFinite(alt) ? alt : null };
}


async function deployWorm(ns, hostname, entry, details) {
    try {
        // Re-check connection before exec — darknet topology and serversOnNetwork can diverge after mutations.
        const dnet = ns.dnet;
        if (dnet) {
            const fresh = dnet.getServerDetails(hostname);
            if (!fresh.isConnectedToCurrentServer) {
                entry._execFails = (entry._execFails || 0) + 1;
                if (entry._execFails % 5 === 0)
                    ns.print(`exec to ${hostname}: not connected (skipped x${entry._execFails})`);
                return;
            }
        }
        ns.scp(ns.getScriptName(), hostname);
        ns.scp(['darknet-looter.js', 'darknet-virus.js', 'crackers.js'], hostname, ns.getHostname());
        const pid = ns.exec(ns.getScriptName(), hostname, { preventDuplicates: true });
        if (pid) {
            ns.exec('darknet-looter.js', hostname, { preventDuplicates: true });
            ns.exec('darknet-virus.js', hostname, { preventDuplicates: true });
            if (details?.modelId === '(The Labyrinth)') {
                ns.scp('labyrinth.js', hostname, ns.getHostname());
                ns.exec('labyrinth.js', hostname, 1);
            }
            entry.deployed = true;
            ns.print(`deployed to ${hostname} (pid ${pid})`);
        }
    } catch (e) { ns.print(`deploy ${hostname} err: ${e}`); }
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