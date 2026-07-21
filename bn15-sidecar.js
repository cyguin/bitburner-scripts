export async function main(ns) {
    ns.disableLog("ALL");
    const TRP = "The Red Pill";
    const DEF_FILE = "/data/bn15-defeats.txt";
    let defeats = 0;
    try { defeats = parseInt(ns.read(DEF_FILE)) || 0; } catch {}
    const save = () => ns.write(DEF_FILE, String(defeats), "w");

    while (defeats < 3) {
        const p = ns.getPlayer();
        const h = p.skills.hacking;
        const owned = ns.singularity?.getOwnedAugmentations?.() || [];
        const hasTRP = owned.includes(TRP);

        if (hasTRP && ns.serverExists("w0r1d_d43m0n")) {
            const req = ns.getServerRequiredHackingLevel("w0r1d_d43m0n");
            if (h >= req) {
                if (!ns.hasRootAccess("w0r1d_d43m0n")) {
                    for (const fn of [ns.brutessh, ns.ftpcrack, ns.relaysmtp, ns.httpworm, ns.sqlinject])
                        try { fn("w0r1d_d43m0n"); } catch {}
                    try { ns.nuke("w0r1d_d43m0n"); } catch {}
                }
                if (ns.hasRootAccess("w0r1d_d43m0n")) {
                    defeats++;
                    save();
                    await ns.hack("w0r1d_d43m0n");
                    ns.tprint(`WD DEFEAT ${defeats}/3`);
                    if (defeats >= 3) return;
                    await ns.sleep(60000);
                    continue;
                }
            }
        }

        await ns.sleep(60000);
    }
}
