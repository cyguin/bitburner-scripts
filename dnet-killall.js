// dnet-killall.js — stop the darknet worm fleet.
//
// Why this exists: exec() with preventDuplicates returns 0 when a script is
// already running, so scp updates a worm file on disk while the live process
// keeps executing whatever it started with. From WORM_VERSION 2 onward each
// worm notices that and exits on its own, but anything older has to be killed
// by hand — otherwise a superseded solver sits there re-sending the same dead
// guess indefinitely.
//
// Finding the hosts is the awkward part. dnet.probe() only returns servers
// directly connected to the one you're standing on, so from home it sees the
// depth-0 entries and nothing deeper. The worm's own password cache is the
// better source: darknet.js writes an entry for every host it has cracked, so
// its keys are exactly the set of hosts likely to be running a worm. Both are
// used, and hosts that have since been deleted are just skipped.
//
// ns.ps() and ns.kill() work on any server by name — no session needed — which
// is what makes this reachable from home at all.
//
// Usage:
//   run dnet-killall.js              kill every worm process it can reach
//   run dnet-killall.js --dry-run    list what it would kill, touch nothing
//   run dnet-killall.js --quiet      summary only, no per-process lines

const WORM_FILES = ['darknet.js', 'darknet-looter.js', 'darknet-virus.js', 'labyrinth.js'];
const CACHE = '/data/dnet-passwords.txt';

export function autocomplete(data) { return ['--dry-run', '--quiet']; }

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog('ALL');
    const dryRun = ns.args.includes('--dry-run');
    const quiet = ns.args.includes('--quiet');
    const say = msg => { if (!quiet) ns.tprint(msg); };

    const hosts = new Set();
    let probed = 0;
    try {
        const dnet = ns.dnet;
        if (dnet) for (const h of dnet.probe()) { hosts.add(h); probed++; }
    } catch { /* not in BN15, or no darknet access */ }
    const cached = cachedHosts(ns);
    for (const h of cached) hosts.add(h);
    // Worth checking even from home: harmless if nothing matches.
    hosts.add(ns.getHostname());

    if (!hosts.size) {
        ns.tprint('dnet-killall: no darknet hosts found (no neighbours, empty cache)');
        return;
    }

    let killed = 0, found = 0, unreachable = 0;
    const touched = new Set();
    for (const host of [...hosts].sort()) {
        let procs;
        // Deleted darknet servers keep their names in the cache, and their
        // hostnames get recycled, so an unknown host here is expected.
        try { procs = ns.ps(host); } catch { unreachable++; continue; }
        if (!Array.isArray(procs)) { unreachable++; continue; }

        for (const p of procs) {
            if (!WORM_FILES.includes(p.filename)) continue;
            found++;
            if (dryRun) {
                say(`  would kill ${p.filename} on ${host} (pid ${p.pid})`);
                touched.add(host);
                continue;
            }
            let ok = false;
            try { ok = ns.kill(p.pid); } catch { ok = false; }
            if (ok) {
                killed++;
                touched.add(host);
                say(`  killed ${p.filename} on ${host} (pid ${p.pid})`);
            } else {
                say(`  FAILED to kill ${p.filename} on ${host} (pid ${p.pid})`);
            }
        }
    }

    ns.tprint(`dnet-killall: ${hosts.size} host(s) checked (${probed} probed, ${cached.length} cached` +
        `${unreachable ? `, ${unreachable} gone` : ''}), ${found} worm process(es) on ${touched.size} host(s)`);
    if (dryRun) {
        ns.tprint('dnet-killall: --dry-run, nothing was killed');
        return;
    }
    ns.tprint(`dnet-killall: killed ${killed}/${found}`);
    if (killed) {
        // autopilot.js redeploys as soon as no darknet.js is running on any
        // host adjacent to home, re-scp'ing from home first — so the fresh
        // copy goes out on its own within a tick or two.
        ns.tprint('dnet-killall: autopilot will redeploy from home once no worm is running on a nearby host');
    }
}

// Hostnames the worm has cracked. darknet.js writes {host: {pw}}, while
// darknet-virus.js writes {host: "password"} to the same path — the two
// formats clobber each other, but either way the keys are the hostnames, which
// is all this needs.
function cachedHosts(ns) {
    try {
        const raw = JSON.parse(ns.read(CACHE));
        return raw && typeof raw === 'object' ? Object.keys(raw) : [];
    } catch { return []; }
}
