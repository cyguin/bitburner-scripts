// crackers.js
// Single source of truth for BN15 darknet password-cracking logic.
// Previously this exact logic (helpers + per-model solvers) was copy-pasted
// independently into darknet.js, darknet-virus.js, and labyrinth.js.
// That's why the same handful of bugs kept reappearing "in all 4 files" and why
// fixes in one copy never made it into the other three. Everything lives here now.
//
// Design change from the old per-file versions: every solver returns the FULL
// ordered list of candidate passwords for a model, most-likely-first, instead of
// a single guess for a given `attempt` index. dnet.authenticate() has no cooldown,
// lockout, or rate limit in this codebase, so there was never a reason to ration
// guesses across a small attempt counter. Callers should just loop the whole
// array. This also fixes the Laika4 and PHP 5.4 bugs for free (see below), since
// "try the whole list in order" naturally reaches the right answer instead of
// giving up after the first mismatch.

// ---- shared helpers ----

export function permute(s) {
    if (s.length <= 1) return [s];
    const result = [];
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (s.indexOf(c) !== i) continue; // skip duplicate leading chars
        for (const sub of permute(s.slice(0, i) + s.slice(i + 1))) result.push(c + sub);
    }
    return result;
}

export function largestPrimeFactor(n) {
    if (n <= 1) return 1;
    let m = n;
    for (let i = 2; i * i <= m; i++) while (m % i === 0) m /= i;
    return m;
}

export function romanDecode(s) {
    const map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    let total = 0;
    for (let i = 0; i < s.length; i++) {
        const cur = map[s[i]] || 0;
        const next = map[s[i + 1]] || 0;
        total += cur < next ? -cur : cur;
    }
    return total;
}

// Generic fallback guesser for any modelId we don't have a specific solver for.
export function guessFromHint(hint, len) {
    len = Math.max(1, len || 1);
    if (!hint || hint === '?') return 'a'.repeat(len);
    const cleaned = hint.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    if (cleaned.length >= len) return cleaned.slice(0, len);
    const nums = hint.match(/\d+/g);
    if (nums && nums[0]) return nums[0].slice(0, len).padEnd(len, '0');
    return cleaned.padEnd(len, 'a').slice(0, len);
}

const DOGS = ["fido","spot","rover","max","bella","luna","charlie","buddy","rocky","daisy","lucy","cooper","sadie","molly","bailey","maggie","duke","bear","toby","lucky","rosie","chloe","pepper","zoey","coco","blue","rex","king","jack","shadow","diesel","harley","rusty","patches","sammy","zoe","moxie","prince","ghost","blaze","dash","buster","baxter","bruno","gunner","thor","odie","snoopy","scooby","laika"];

const EU_COUNTRIES = ['Austria', 'Belgium', 'Bulgaria', 'Croatia', 'Republic of Cyprus', 'Czech Republic', 'Denmark', 'Estonia', 'Finland', 'France', 'Germany', 'Greece', 'Hungary', 'Ireland', 'Italy', 'Latvia', 'Lithuania', 'Luxembourg', 'Malta', 'Netherlands', 'Poland', 'Portugal', 'Romania', 'Slovakia', 'Slovenia', 'Spain', 'Sweden'];

const TOP_PASSWORDS = ['123456', 'password', '12345678', 'qwerty', '12345', '123456789', 'football', 'iloveyou', 'admin', 'welcome'];

// Shared safety ceiling for consumers that don't have their own configurable
// retry option (darknet.js uses its own max-auth-retries opt; the other three
// files use this constant so no loop over a candidate list runs unbounded).
export const MAX_CRACK_ATTEMPTS = 60;

/**
 * Returns the full ordered array of candidate passwords for a given darknet
 * server model. Callers should try every entry in order until one succeeds
 * (or the list runs out); there's no reason to cap this artificially.
 *
 * @param {string} modelId
 * @param {string} hint    passwordHint from getServerDetails()
 * @param {number} len     passwordLength from getServerDetails()
 * @param {string} data    the `data` field from getServerDetails(), when present
 */
export function getCandidates(modelId, hint, len, data) {
    const h = hint || '';
    const l = Math.max(1, len || 1);
    const d = data ?? '';

    switch (modelId) {
        case 'ZeroLogon':
            return [''];

        case 'FreshInstall_1.0':
            return ['admin', 'password', '0000', '12345'].map(s => s.slice(0, l));

        case 'DeskMemo_3.1': {
            const src = d || h;
            const dig = src.replace(/[^0-9]/g, '');
            if (dig.length >= l) return [dig.slice(0, l)];
            const alnum = src.replace(/[^a-zA-Z0-9]/g, '');
            return [alnum.slice(0, l) || 'a'];
        }

        case 'CloudBlare(tm)': {
            // FIX: previously gated behind `dig.length >= 6` in one of the four
            // copies, which meant it fell through to a useless '000000' guess
            // any time the extracted digit string was shorter than 6, even if
            // it was already the right length for this puzzle's actual `len`.
            const dig = d.replace(/[^0-9]/g, '');
            return [dig.slice(0, l) || '0'.repeat(l)];
        }

        case 'PR0verFL0': {
            const words = ['overfl', 'prover', 'buffer', 'admin', 'overflow', 'prove', 'proof'];
            return words.map(w => w.slice(0, l));
        }

        case 'DeepGreen': {
            // Mastermind-style code. No real deduction from feedback is
            // implemented here (never was); this just walks numeric codes of
            // the right length in order, capped at MAX_CRACK_ATTEMPTS since
            // brute-forcing the full space (up to 10,000 codes for len=4)
            // isn't something any consumer should churn through uncapped.
            const digits = Math.min(l, 4);
            const max = Math.min(Math.pow(10, digits), MAX_CRACK_ATTEMPTS);
            const out = [];
            for (let i = 0; i < max; i++) out.push(String(i).padStart(digits, '0'));
            return out;
        }

        case '2G_cellular':
            return [String(0).padStart(l, '0')];

        case 'PrimeTime 2': {
            const target = parseInt(d || h.replace(/[^0-9]/g, ''), 10);
            return [target ? String(largestPrimeFactor(target)) : '2'];
        }

        case 'BellaCuore': {
            const roman = (d || h).toUpperCase().replace(/[^IVXLCDM]/g, '');
            return [roman ? String(romanDecode(roman)) : '1'];
        }

        case 'Laika4': {
            // FIX: previously indexed dogs[attempt] directly and gave up
            // immediately (returning a hardcoded "fido") the moment the name
            // at that index didn't happen to match `len`, instead of looking
            // further into the list for one that did. Filter first, then
            // return every name of the right length, in original order.
            const matches = DOGS.filter(name => !len || name.length === l);
            return matches.length ? matches : ['fido'];
        }

        case 'AccountsManager_4.2': {
            // This is a higher/lower guessing game and genuinely needs live
            // feedback between guesses to solve efficiently; a fixed candidate
            // list can't adapt mid-search. This returns a reasonable spread of
            // guesses across the hinted range as an interim measure (better
            // than the single-guess-per-call version, which had no memory of
            // prior real attempts at all), but the real fix is a dedicated
            // interactive solver that reads each authenticate() response
            // before generating the next guess. Flagging this rather than
            // pretending it's fully solved.
            const range = h.match(/between\s*(\d+)\s*and\s*(\d+)/i);
            let lo = 0, hi = 100;
            if (range) { lo = parseInt(range[1], 10); hi = parseInt(range[2], 10); }
            const mid = Math.floor((lo + hi) / 2);
            const step = Math.max(1, Math.floor((hi - lo) / 4));
            const guesses = [
                mid, mid + step, mid - step, mid + 2 * step, mid - 2 * step,
                Math.floor(mid + step / 2), Math.floor(mid - step / 2), hi, lo,
            ].filter(g => g >= lo && g <= hi);
            return [...new Set(guesses)].map(g => String(g).padStart(l, '0'));
        }

        case 'TopPass':
            return TOP_PASSWORDS.slice();

        case 'EuroZone Free':
            return EU_COUNTRIES.flatMap(c => [c.toLowerCase(), c]);

        case 'NIL': {
            const c = (d || h || '0').charAt(0);
            return [(c >= '0' && c <= '9' ? c : '0').repeat(l)];
        }

        case '110100100': {
            const bin = (d || h).replace(/[^01]/g, '');
            const bytes = bin.match(/.{8}/g) || [];
            const decoded = bytes.map(b => String.fromCharCode(parseInt(b, 2))).join('');
            return [decoded || '110100100'];
        }

        case 'RateMyPix.Auth': {
            const count = d.split('\ud83c\udf36').length - 1;
            return [count > 0 ? String(count) : '0'.repeat(l)];
        }

        case 'OctantVoxel': {
            if (!d) return ['10'];
            const [baseStr, encoded = ''] = d.split(',');
            const base = parseFloat(baseStr);
            if (!base || !encoded) return ['10'];
            const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
            let result = 0, dotSeen = false, frac = 0, fracDiv = 1;
            for (const c of encoded) {
                if (c === '.') { dotSeen = true; continue; }
                const v = chars.indexOf(c);
                if (v < 0) continue;
                if (!dotSeen) result = result * base + v;
                else { frac = frac * base + v; fracDiv *= base; }
            }
            return [String(result + frac / fracDiv)];
        }

        case 'MathML': {
            const expr = (d || h).replace(/[^0-9+\-*/().]/g, '');
            if (!expr) return ['0'];
            try { return [String(eval(expr))]; } catch { return ['0']; }
        }

        case 'Factori-Os':
            // Unclear puzzle semantics; darknet.js guessed '1'-repeated,
            // darknet-virus.js gave up with an empty list. Guessing something
            // beats guessing nothing, keeping the non-empty behavior.
            return ['1'.repeat(l)];

        case 'BigMo%od':
            return [''];

        case 'KingOfTheHill': {
            const dig = d.replace(/[^0-9]/g, '');
            return [dig ? dig.slice(0, Math.min(l, 8)) : '0'];
        }

        case 'PHP 5.4': {
            // FIX: previously only tried permutations when the extracted digit
            // string was 4 characters or shorter; anything longer just
            // returned the digits in raw extraction order, every attempt,
            // forever, with no permutation attempt at all. Permutations of a
            // digit string grow factorially (10! is 3.6M), so cap the input
            // length fed to permute() rather than skipping permutation
            // entirely for longer hints.
            const digs = (d || h).replace(/[^0-9]/g, '');
            if (digs.length > 0 && digs.length <= 6) {
                const perms = [...new Set(permute(digs).map(p => p.slice(0, l)))];
                if (perms.length) return perms;
            }
            return [digs.slice(0, l) || '0'];
        }

        case 'OpenWebAccessPoint': {
            const packet = d || '';
            const out = [];
            // Direct password markers (most reliable)
            const direct = packet.match(/--(\w+)--/);
            if (direct) out.push(direct[1]);
            const neighbor = packet.match(/Connecting to\s+\S+:(\w+)/i);
            if (neighbor) out.push(neighbor[1]);
            const passcode = packet.match(/passcode:\s*["']?(\w+)["']?\s*\./i);
            if (passcode) out.push(passcode[1]);
            const pws = packet.match(/(?:password|pin|code|key|pass)\s*(?::|is|set to)\s*["']?(\w+)["']?/i);
            if (pws) out.push(pws[1]);
            // Extract any standalone multi-digit numbers (likely part of the code)
            const multiDigits = packet.match(/\b(\d{4})\b/g);
            if (multiDigits) out.push(...multiDigits);
            // Bell pepper pattern (-- with special chars between)
            const bell = packet.match(/(?:\d{2})(\d{4})(?:\d{2})/g);
            if (bell) out.push(...bell);
            // Any multi-digit groups from the entire text
            const nums = packet.replace(/[^0-9]/g, '');
            if (nums && nums.length >= l) {
                // Try chunks of length `l` from the numeric mass
                for (let i = 0; i <= nums.length - l; i++)
                    out.push(nums.slice(i, i + l));
            }
            return out.length ? [...new Set(out)] : ['admin'];
        }

        case 'OrdoXenos': {
            if (!d) return ['0'];
            const [encrypted = '', maskStr = ''] = d.split(';');
            const masks = maskStr.split(' ').filter(Boolean).map(m => parseInt(m, 2));
            let result = '';
            for (let i = 0; i < encrypted.length && i < masks.length; i++) {
                result += String.fromCharCode(encrypted.charCodeAt(i) ^ masks[i]);
            }
            return [result.replace(/[^a-zA-Z0-9]/g, '') || '0'];
        }

        default: {
            // Generic hint-scraping fallback, used for 'defaultModel' and any
            // unrecognized modelId.
            const nums = h.match(/\b\d{3,12}\b/g) || [];
            if (nums.length) return [...new Set(nums)];
            const digs = [...new Set(h.match(/\d/g) || [])];
            if (digs.length >= 2) {
                const r = new Set();
                for (const a of digs) for (const b of digs) r.add(a + b);
                for (let i = 0; i < digs.length && i < 4; i++)
                    for (let j = 0; j < digs.length && j < 4; j++)
                        for (let k = 0; k < digs.length && k < 4; k++)
                            if (i !== j && j !== k) r.add(digs[i] + digs[j] + digs[k]);
                return [...r];
            }
            return [guessFromHint(h, l), 'admin', 'password', '123456', 'root'];
        }
    }
}
