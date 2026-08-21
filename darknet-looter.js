export function autocomplete(data) { return ['--storm']; }

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


export async function main(ns) {
    ns.disableLog('ALL');
    let dnet;
    try { dnet = ns.dnet; } catch { return; }
    if (!dnet || !dnet.isDarknetServer(ns.getHostname())) return;

    // Off unless asked for explicitly. See handleStormSeed().
    const unleash = ns.args.includes('--storm');
    let reportedStorm = false;

    while (true) {
        if (isStale(ns)) {
            ns.print(`newer darknet-looter.js on disk (was v${WORM_VERSION}) - exiting so it can start`);
            return;
        }
        try {
            const server = ns.getHostname();
            const files = ns.ls(server);
            // Open caches
            for (const f of files.filter(f => f.endsWith('.cache')))
                try { await dnet.openCache(f, true); } catch {}
            // Report (or, opted in, fire) a storm seed sitting on this host
            if (files.includes(STORM_SEED) && !reportedStorm)
                reportedStorm = handleStormSeed(ns, dnet, server, unleash);
            // Free the owner's blocked RAM
            await drainRamBlock(ns, dnet, server);
            // Phishing loop
            try { await dnet.phishingAttack(); } catch {}
        } catch {}
        await ns.sleep(15000);
    }
}

const STORM_SEED = 'STORM_SEED.exe';

// STORM_SEED.exe is what the darknet UI means by "A mysterious executable has
// been found here...". It is not loot, and there is nothing to collect: it is
// a hazard that lands on a server when a RAM block is fully cleared (15%
// chance, at most one in existence, 30 minute cooldown).
//
// Running it calls launchWebstorm(), which deletes ~60% of the movable darknet
// servers outright, then restartServer()s every survivor - killing their
// scripts, clearing every authenticated PID, and wiping backdoors - before
// spawning fresh waves over the following ~12 seconds. That is the entire worm
// fleet and every session it holds. The in-game docs are blunt about it:
// "creates a webstorm that can cause catastrophic damage to the darknet. Run
// at your own risk."
//
// So the default is to report and leave it alone. Note that restartServer()
// never touches server.password, so /data/dnet-passwords.txt still gets you
// back into whatever survives a storm - it is the sessions, scripts, and
// backdoors that have to be rebuilt.
//
// The one reason to want a storm is the reshuffle: it re-rolls the topology
// when the net has settled into a shape you can't get any deeper into. To fire
// one deliberately, run this script on the host holding the file with --storm.
// unleashStormSeed() takes no arguments and always acts on the server it is
// running from, so it has to be that host.
function handleStormSeed(ns, dnet, server, unleash) {
    if (!unleash) {
        ns.tprint(`WARN: ${STORM_SEED} found on ${server}. Leaving it alone - running it wipes the darknet. ` +
            `To fire it anyway: run darknet-looter.js --storm on ${server}.`);
        return true;
    }
    ns.tprint(`WARN: unleashing ${STORM_SEED} on ${server} - the darknet is about to be rebuilt.`);
    try {
        const r = dnet.unleashStormSeed();
        ns.print(`unleashStormSeed on ${server}: ${r?.message || 'no response'}`);
    } catch (e) {
        ns.print(`unleashStormSeed on ${server} failed: ${e?.message || e}`);
    }
    return true;
}

// Calls per cycle. Each call blocks for max(8000 * 500/(500+cha), 200) ms, so
// this trades off against how often caches and phishing get a turn. Charisma
// (which phishing builds) shortens each call, so the drain speeds up over time.
const RAM_BLOCK_CALLS_PER_CYCLE = 10;

// Frees RAM that the server's owner has blocked off.
//
// This used to live in darknet.js as a single fire-and-forget call per cycle,
// which is why it looked like it never ran: one call only chips off
// getRamBlockRemoved(), roughly
//     0.02 * 2 * 0.92^(difficulty+1) * threads * (1 + charisma/100) GB
// which is on the order of 0.04 GB at 1 thread. Servers over 64GB can have
// their entire maxRam blocked, so a call-per-cycle never visibly moves the
// number. It has to loop, and it's worth looping: fully clearing a block drops
// a .cache file on the server and rolls for a clue and a stormSeed program,
// on top of freeing the RAM itself.
//
// Note this always targets the host the script is running on, and a server is
// always "directly connected" to itself, so a drain in progress can't be
// broken by a topology mutation the way authenticate() can.
async function drainRamBlock(ns, dnet, server) {
    for (let i = 0; i < RAM_BLOCK_CALLS_PER_CYCLE; i++) {
        let r;
        try { r = await dnet.memoryReallocation(server); } catch { return; }
        // First non-success ends the drain. Code 454 (NoBlockRAM) means the
        // block is clear - the common case, and the cheap no-op on later
        // cycles. Anything else means the server went offline or unauthorized.
        if (!r || !r.success) {
            if (i > 0) ns.print(`ram block on ${server}: ${r?.message || 'stopped'} after ${i} calls`);
            return;
        }
        if (i === 0) ns.print(`draining ram block on ${server}: ${r.message}`);
    }
    ns.print(`ram block on ${server}: still blocked, continuing next cycle`);
}
