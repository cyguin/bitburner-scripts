export async function main(ns) {
    ns.disableLog('ALL');
    let dnet;
    try { dnet = ns.dnet; } catch { return; }
    if (!dnet || !dnet.isDarknetServer(ns.getHostname())) return;

    while (true) {
        try {
            const server = ns.getHostname();
            // Open caches
            for (const f of ns.ls(server).filter(f => f.endsWith('.cache')))
                try { await dnet.openCache(f, true); } catch {}
            // Phishing loop
            try { await dnet.phishingAttack(); } catch {}
        } catch {}
        await ns.sleep(15000);
    }
}
