export async function main(ns) {
    while (true) {
        for (const f of ns.ls(ns.getHostname(), ".cache")) {
            try { await ns.dnet.openCache(f); } catch {}
        }
        try { await ns.dnet.phishingAttack(); } catch {}
        try { await ns.dnet.memoryReallocation(); } catch {}
        await ns.sleep(15000);
    }
}
