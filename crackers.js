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

// Decodes one roman numeral, or null if the string isn't one.
//
// Upstream's romanNumeralEncoder returns the literal "nulla" for zero, and
// that word is a trap: uppercasing it and stripping to [IVXLCDM] leaves "LL",
// so a naive decoder reads Latin for "nothing" as 100. Handle it explicitly
// and reject anything that isn't a numeral rather than silently scoring the
// characters that happen to survive a filter.
export function romanDecode(s) {
    const t = String(s ?? '').trim();
    if (!t) return null;
    if (t.toLowerCase() === 'nulla') return 0;
    if (!/^[IVXLCDM]+$/i.test(t)) return null;
    const map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    const u = t.toUpperCase();
    let total = 0;
    for (let i = 0; i < u.length; i++) {
        const cur = map[u[i]];
        const next = map[u[i + 1]] || 0;
        total += cur < next ? -cur : cur;
    }
    return total;
}

// BellaCuore ships its numerals two ways (getRomanNumeralConfig):
//   difficulty <  8:  passwordHintData = the encoded password
//   difficulty >= 8:  passwordHintData = "encodedMin,encodedMax", a range
// Returns {exact} or {lo, hi}, or null if neither parses.
export function romanHint(data, hint) {
    const src = String(data ?? '').trim() || String(hint ?? '').match(/'([^']*)'\s*and\s*'([^']*)'/)?.slice(1, 3).join(',') || '';
    if (!src) return null;
    const parts = src.split(',').map(x => x.trim()).filter(Boolean);
    if (parts.length >= 2) {
        // Decode each bound on its own. Concatenating them first is what turned
        // "nulla,LXVIII" (0 to 68) into the single numeral 168.
        const lo = romanDecode(parts[0]), hi = romanDecode(parts[1]);
        if (lo == null || hi == null) return null;
        return { lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
    }
    const exact = romanDecode(parts[0]);
    return exact == null ? null : { exact };
}

// Upstream's cleanArithmeticExpression, verbatim. Order matters: the
// "ns.exit()," splice is removed before the split on "," so that a nested
// injection doesn't truncate the real expression early.
export function cleanArithmetic(expression) {
    return String(expression ?? '')
        .replaceAll('\u04B3', '*')
        .replaceAll('\u00F7', '/')
        .replaceAll('\u2795', '+')
        .replaceAll('\u2796', '-')
        .replaceAll('ns.exit(),', '')
        .split(',')[0];
}

// Recursive-descent evaluator for the cleaned expression. Deliberately not
// eval(): the injected tail exists precisely to catch that, and a parser that
// only understands numbers, + - * / and parentheses can't be made to run
// anything. Standard precedence, matching upstream's
// parseSimpleArithmeticExpression (parentheses, then * and /, then + and -).
// Returns null on anything malformed.
export function evalArithmetic(expr) {
    const src = String(expr ?? '');
    let i = 0;
    const ws = () => { while (i < src.length && src[i] === ' ') i++; };
    const peek = () => { ws(); return src[i]; };

    const parseAtom = () => {
        ws();
        if (src[i] === '(') {
            i++;
            const v = parseSum();
            ws();
            if (src[i] !== ')') return null;
            i++;
            return v;
        }
        if (src[i] === '-') { i++; const v = parseAtom(); return v == null ? null : -v; }
        if (src[i] === '+') { i++; return parseAtom(); }
        const m = /^\d*\.?\d+/.exec(src.slice(i));
        if (!m) return null;
        i += m[0].length;
        return parseFloat(m[0]);
    };
    const parseProduct = () => {
        let v = parseAtom();
        if (v == null) return null;
        for (;;) {
            const op = peek();
            if (op !== '*' && op !== '/') return v;
            i++;
            const r = parseAtom();
            if (r == null) return null;
            v = op === '*' ? v * r : v / r;
        }
    };
    const parseSum = () => {
        let v = parseProduct();
        if (v == null) return null;
        for (;;) {
            const op = peek();
            if (op !== '+' && op !== '-') return v;
            i++;
            const r = parseProduct();
            if (r == null) return null;
            v = op === '+' ? v + r : v - r;
        }
    };

    const out = parseSum();
    ws();
    return i === src.length && out != null && Number.isFinite(out) ? out : null;
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

// Upstream's commonPasswordDictionary verbatim (models/dictionaryData.ts).
// This used to be a hand-written top-10, which is why TopPass sat at an 8%
// solve rate: getLargeDictionaryConfig draws uniformly from all 93 entries,
// and "thomas", "asdfgh" and "987654321" were never among the ten guesses.
// The caller filters by password length, which is what keeps this inside the
// attempt cap - the longest bucket (6 characters) holds 53 entries.
const TOP_PASSWORDS = [
    "123456", "password", "12345678", "qwerty", "123456789", "12345", "1234", "111111", "1234567",
    "dragon", "123123", "baseball", "abc123", "football", "monkey", "letmein", "696969", "shadow",
    "master", "666666", "qwertyuiop", "123321", "mustang", "1234567890", "michael", "654321",
    "superman", "1qaz2wsx", "7777777", "121212", "0", "qazwsx", "123qwe", "trustno1", "jordan",
    "jennifer", "zxcvbnm", "asdfgh", "hunter", "buster", "soccer", "harley", "batman", "andrew",
    "tigger", "sunshine", "iloveyou", "2000", "charlie", "robert", "thomas", "hockey", "ranger",
    "daniel", "starwars", "112233", "george", "computer", "michelle", "jessica", "pepper", "1111",
    "zxcvbn", "555555", "11111111", "131313", "freedom", "777777", "pass", "maggie", "159753",
    "aaaaaa", "ginger", "princess", "joshua", "cheese", "amanda", "summer", "love", "ashley",
    "6969", "nicole", "chelsea", "biteme", "matthew", "access", "yankees", "987654321", "dallas",
    "austin", "thunder", "taylor", "matrix"
];

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

        // Upstream spells this "Pr0verFl0" (Enums.ts BufferOverflow). The old
        // 'PR0verFL0' spelling here never matched a real server, so this
        // branch was dead and the model fell through to the default guesser.
        case 'Pr0verFl0': {
            // Not a password guess at all. checkPassword() lays out a buffer of
            // `len` received chars followed by `len` expected chars, copies the
            // attempt over it, then compares the two halves - so any 2*len
            // string whose halves are equal authenticates. Dictionary words
            // were never going to work.
            //
            // NOTE: a caller that truncates candidates to passwordLength (as
            // the generic loop in darknet.js does) will cut this back to `len`
            // and defeat it. darknet.js routes this model to authInteractive()
            // for that reason.
            return ['a'.repeat(l * 2)];
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
            // Every attempt's message reports the index of the first wrong
            // character, which builds the password left to right - so this is
            // a prefix oracle and needs the response to each probe.
            // darknet.js handles it in authTimingAttack() and never gets here.
            // The old "0".repeat(len) was a single candidate that could only
            // ever be re-sent unchanged.
            return [String(0).padStart(l, '0')];

        case 'PrimeTime 2': {
            const target = parseInt(d || h.replace(/[^0-9]/g, ''), 10);
            return [target ? String(largestPrimeFactor(target)) : '2'];
        }

        case 'BellaCuore': {
            // Two forms. Below difficulty 8 the data is the password itself,
            // roman-encoded, so it decodes in one step. At or above 8 it is a
            // range and the model becomes a higher/lower guessing game with
            // Latin feedback ("ALTUS NIMIS" too high, "PARUM BREVIS" too low),
            // which needs the response to each attempt - darknet.js routes that
            // case to authHiLo() and never reaches here.
            //
            // The old branch uppercased the whole data string and stripped it
            // to [IVXLCDM], which mangles the range form badly: the two Ls in
            // "NULLA" survive, so "nulla,LXVIII" (0 to 68) decoded as the
            // single numeral LLLXVIII = 168.
            const parsed = romanHint(d, h);
            if (!parsed) return ['1'];
            if (parsed.exact != null) return [String(parsed.exact)];
            const lo = Math.max(parsed.lo, l === 1 ? 0 : Math.pow(10, Math.min(l, 6) - 1));
            const hi = Math.min(parsed.hi, Math.pow(10, Math.min(l, 6)) - 1);
            const out = [];
            for (let n = lo; n <= hi; n++) out.push(String(n));
            return out.length ? out : [String(parsed.lo)];
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
            // Higher/lower guessing game. Solving it properly means reading
            // each attempt's "Lower"/"Higher" feedback back out of the server's
            // packet log with heartbleed() - authenticate() itself returns no
            // data for this model - which a static candidate list can't do.
            // darknet.js routes this model to authAccountsManager() and never
            // reaches here; this branch is the no-feedback fallback, so it
            // sweeps the whole space (authenticate() has no cooldown).
            //
            // The password is stored as String(n), never zero-padded, so a
            // length-L password is a plain L-digit decimal: 0-9 for L=1,
            // 10-99 for L=2. The hint's "between 0 and 10^L" upper bound is
            // just the length restated; the low end is not 0.
            const lo = l === 1 ? 0 : Math.pow(10, Math.min(l, 6) - 1);
            const hi = Math.pow(10, Math.min(l, 6)) - 1;
            const out = [];
            for (let n = lo; n <= hi; n++) out.push(String(n));
            return out;
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
            // "Bulls-only" Mastermind: each attempt scores one chilli per
            // character sitting in exactly the right position ("\ud83c\udf36\ufe0f\ud83c\udf36\ufe0f/5"), so
            // it can only be solved by reading the score between attempts.
            // darknet.js routes this model to authSpiceLevel() and never
            // reaches here.
            //
            // The previous version counted chillis in `data` and returned that
            // count as the password. The chilli count is per-attempt feedback,
            // not a server property, and this model sets no passwordHintData
            // at all - its only static hint is the literal "!!\ud83c\udf36\ufe0f!!" - so `data`
            // was always "" and this always guessed "0".repeat(len).
            //
            // Without a feedback channel the best a static list can do is the
            // all-one-character probes, which win outright on the occasional
            // uniform password and are the same probes the real solver opens
            // with. Letters only appear above difficulty 8.
            const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
            return alphabet.split('').map(c => c.repeat(l));
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
            // Above difficulty 12 the operators are swapped for lookalikes
            // (ҳ ÷ ➕ ➖), and above 16 there's a decent chance the expression
            // has a code-injection tail bolted on - a deliberate trap for
            // anyone who reaches for eval():
            //   , !globalThis.pwn3d && (globalThis.pwn3d=true, alert(...) ...
            // plus sometimes an "ns.exit()," spliced inside a parenthesis.
            //
            // The old branch did exactly the wrong two things: it stripped
            // every character outside [0-9+-*/().], which deletes all four
            // lookalike operators and silently fuses the operands into one
            // enormous number, and then it ran eval() on the result. It solved
            // half the servers it saw - the ones below difficulty 13, where
            // the operators are still ASCII.
            const cleaned = cleanArithmetic(d || h);
            const val = evalArithmetic(cleaned);
            return [val == null ? '0' : String(val)];
        }

        case 'Factori-Os': {
            // A divisibility oracle: whatever number you send, the response
            // says whether it divides the password. Solving it means probing
            // primes and reading "true"/"false" back out of the packet log, so
            // darknet.js routes this to authFactoriOs() and never gets here.
            //
            // The old '1'.repeat(len) guess had nothing behind it - the hint
            // "The password is divisible by 1 ;)" is a joke, not a clue.
            //
            // Upstream builds the password as a product of primes, but with no
            // oracle there's nothing to narrow with: any integer of the right
            // digit count is a candidate. So sweep the range ascending, which
            // at least covers low-difficulty servers outright - below
            // difficulty 5 the password is just a small base with no extra
            // factors applied.
            const lo = l === 1 ? 1 : Math.pow(10, Math.min(l, 6) - 1);
            const hi = Math.pow(10, Math.min(l, 6)) - 1;
            const out = [];
            for (let n = lo; n <= hi; n++) out.push(String(n));
            return out;
        }

        case 'BigMo%od':
            // (password % n) % (((n - 1) % 32) + 1) for whatever n you send -
            // only solvable by collecting residues and reconstructing by CRT,
            // which needs the response to each probe. darknet.js handles it in
            // authBigMod(); an empty guess is as good as anything from here.
            return [''];

        case 'KingOfTheHill': {
            // Each attempt reports an altitude on a Gaussian landscape; the
            // password is the global maximum. Needs the readings, so this is
            // authKingOfTheHill()'s job. Scraping digits out of `d` never made
            // sense - this model sets no passwordHintData either.
            const lo = l === 1 ? 0 : Math.pow(10, Math.min(l, 6) - 1);
            const hi = Math.pow(10, Math.min(l, 6)) - 1;
            const out = [];
            for (let n = lo; n <= hi; n++) out.push(String(n));
            return out;
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
            // The packet dump that leaks this password is the failure data of
            // an authenticate() call - it is generated fresh per attempt by
            // capturePackets() and never appears in getServerDetails(). This
            // model sets no passwordHintData at all, so `d` here is always "".
            // The previous version ran six regexes over that empty string and
            // fell through to 'admin' every time.
            //
            // darknet.js routes this to authOpenWeb(), which reads the dump
            // off the response and either regexes out `hostname:password` or
            // intersects substrings across captures. Nothing useful is
            // possible from static details, so keep it honest and cheap.
            return ['admin', 'password', 'guest'];
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
