import { getCandidates, MAX_CRACK_ATTEMPTS } from './crackers.js';

const DB = "/data/dnet-passwords.json";
const CRACKED = "/data/cracked-servers.txt";
const HOME = "home";
const LOOT = "darknet-looter.js";
const LAB = "labyrinth.js";

export async function main(ns) {
    const self = ns.getScriptName();
    const here = ns.getHostname();
    try { ns.scp(DB, here, HOME); } catch {}
    let pw = {};
    try { pw = JSON.parse(ns.read(DB)); } catch {}
    const save = () => {
        ns.write(DB, JSON.stringify(pw), "w");
        try { ns.scp(DB, HOME); } catch {}
    };

    while (true) {
        ns.scp(CRACKED, here, HOME);
        let cracked = {};
        try { cracked = JSON.parse(ns.read(CRACKED) || "{}"); } catch {}

        for (const target of ns.dnet.probe()) {
            if (target === here) continue;
            const d = ns.dnet.getServerDetails(target);
            if (!d.isOnline) continue;
            if (ns.getServerMaxRam(target) < 11) continue;
            if (d.hasSession) continue;
            if (cracked[target]) {
                const pw2 = cracked[target].password;
                if (!pw2) { delete cracked[target]; continue; }
                try {
                    const r = ns.dnet.connectToSession(target, pw2);
                    if (!r.success) { delete cracked[target]; continue; }
                } catch { delete cracked[target]; continue; }
            }
            const pwd = await crack(ns, target, d, pw);
            if (pwd && typeof pwd === 'string' && pwd.length > 0) {
                pw[target] = pwd;
                save();
                cracked[target] = { password: pwd, modelId: d.modelId, crackedAt: Date.now() };
                ns.write(CRACKED, JSON.stringify(cracked), "w");
                ns.scp(CRACKED, HOME);
            }
        }

        for (const f of ns.ls(here, '.data.txt')) {
            try {
                const content = ns.read(f) || '';
                const leaked = harvestPassword(content, here);
                if (leaked && !pw[here]) { pw[here] = leaked; save(); }
                const nm = content.match(/Server:\s*"?'?(\S+)"?'?\s*Password:\s*"?'?(\w+)"?'?/i);
                if (nm && nm[1] && nm[2] && !pw[nm[1]]) { pw[nm[1]] = nm[2]; save(); }
                const rm = content.match(/Remember this password:\s*"?'?(\w+)"?'?/i);
                if (rm && rm[1] && !pw[here]) { pw[here] = rm[1]; save(); }
            } catch {}
        }

        for (const target of ns.dnet.probe()) {
            if (target === here) continue;
            if (!ns.dnet.getServerDetails(target).hasSession) continue;
            if (!ns.isRunning(LOOT, target)) {
                await ns.scp(self, target);
                await ns.scp(LOOT, target);
                ns.exec(self, target, { preventDuplicates: true });
                ns.exec(LOOT, target);
            }
            if (!ns.isRunning(LAB, target)) {
                ns.kill(LOOT, target);
                await ns.scp(LAB, target);
                ns.exec(LAB, target, { preventDuplicates: true });
            }
        }

        for (const f of ns.ls(here, ".cache")) {
            try { await ns.dnet.openCache(f); } catch {}
        }
        if (ns.dnet.isDarknetServer(here)) {
            try { await ns.dnet.phishingAttack(); } catch {}
            try { await ns.dnet.memoryReallocation(); } catch {}
        }
    }
}

function harvestPassword(logs, hostname) {
    if (!logs || typeof logs !== 'string') return null;

    // Direct --password-- leak pattern
    const directLeak = logs.match(/--([a-zA-Z0-9]+)--/);
    if (directLeak) return directLeak[1];

    // passcode login pattern
    const passcode = logs.match(/passcode:\s*["']?(\w+)["']?\s*\./i) || logs.match(/passcode:\s*["']?(\w+)["']?\s*\.\./i);
    if (passcode) return passcode[1];

    // Connecting to host:password pattern (neighbor password leak)
    const neighborLeak = logs.match(/Connecting to\s+(\S+):(\w+)\s/i);
    if (neighborLeak) return neighborLeak[2];

    // passwordAttempted field from auth logs
    const authAttempt = logs.match(/passwordAttempted["']?\s*:\s*["']?(\w+)/i);
    if (authAttempt) return authAttempt[1];

    // password: value from structured logs
    const passField = logs.match(/password["']?\s*[:\s]+\s*["']?(\w+)/i);
    if (passField) return passField[1];

    // PIN is X
    const pin = logs.match(/PIN\s+is\s+(\w+)/i);
    if (pin) return pin[1];

    return null;
}

async function crack(ns, target, d, pw) {
    const candidatesList = candidates(d, pw);
    for (const pwd of candidatesList) {
        if (typeof pwd !== 'string') continue;
        try {
            const r = await ns.dnet.authenticate(target, pwd);
            if (r.success) return pwd;
            const b = await ns.dnet.heartbleed(target);
            const logs = b.logs || "";
            const leaked = harvestPassword(logs, target);
            if (leaked && !candidatesList.includes(leaked)) {
                pw[d.hostname] = leaked;
                const r2 = await ns.dnet.authenticate(target, leaked);
                if (r2.success) return leaked;
            }
        } catch {}
        await ns.sleep(50);
    }
    return null;
}

function candidates(d, pw) {
    if (pw[d.hostname]) return [pw[d.hostname]];
    return getCandidates(d.modelId, d.passwordHint || "", d.passwordLength || 1, d.data ?? '').slice(0, MAX_CRACK_ATTEMPTS);
}
