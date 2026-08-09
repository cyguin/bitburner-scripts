/** @param {NS} ns
 * Download scripts directly from raw.githubusercontent.com.
 * The GitHub API is NOT used, so this is never rate-limited and works even
 * after a full wipe of the game's script folder.
 *
 * Usage:
 *   run download.js               # Download the default set of repo files
 *   run download.js file1.js foo/bar.js ...  # Download ONLY the listed files
 *   run download.js --branch dev  # Override branch (default: main)
 *
 * NOTE: Keep the default file list in sync when adding files to the repo. */
const argsSchema = [
    ['github', 'cyguin'],
    ['repository', 'bitburner-scripts'],
    ['branch', 'main'],
];

// Default files to restore (all tracked scripts in the repo, minus runtime data).
const defaultFiles = [
    'Remote/grow-target.js',
    'Remote/hack-target.js',
    'Remote/manualhack-target.js',
    'Remote/share.js',
    'Remote/weak-target.js',
    'Tasks/backdoor-all-servers.js',
    'Tasks/backdoor-all-servers.js.backdoor-one.js',
    'Tasks/contractor.js',
    'Tasks/contractor.js.solver.js',
    'Tasks/crack-host.js',
    'Tasks/program-manager.js',
    'Tasks/ram-manager.js',
    'Tasks/run-with-delay.js',
    'Tasks/tor-manager.js',
    'Tasks/write-file.js',
    'analyze-hack.js',
    'ascend.js',
    'autopilot.js',
    'bladeburner.js',
    'bn15-sidecar.js',
    'casino.js',
    'cheat-tool.js',
    'cleanup.js',
    'crackers.js',
    'crime.js',
    'daemon.js',
    'darknet-looter.js',
    'darknet-virus.js',
    'darknet.js',
    'dev-console.js',
    'download.js',
    'dump-ns-namespace.js',
    'faction-manager.js',
    'farm-intelligence.js',
    'gangs.js',
    'git-pull.js',
    'go.js',
    'grep.js',
    'hacknet-upgrade-manager.js',
    'helpers.js',
    'host-manager.js',
    'kill-all-scripts.js',
    'labyrinth.js',
    'optimize-stanek.js',
    'reserve.js',
    'run-command.js',
    'scan.js',
    'sleeve.js',
    'spend-hacknet-hashes.js',
    'stanek.js',
    'stanek.js.create.js',
    'stats.js',
    'stockmaster.js',
    'sync-scripts.js',
    'work-for-factions.js',
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns **/
export async function main(ns) {
    const options = ns.flags(argsSchema);
    // Bare args (land in options._) replace the default set when provided.
    const files = (options._ || []).length > 0 ? options._ : defaultFiles;

    const baseUrl = `https://raw.githubusercontent.com/${options.github}/${options.repository}/${options.branch}/`;
    let successCount = 0;
    for (const file of files) {
        const url = `${baseUrl}${file}?ts=${Date.now()}`;
        ns.print(`Downloading "${file}" from ${url} ...`);
        if (await ns.wget(url, file)) {
            ns.tprint(`SUCCESS: Downloaded "${file}"`);
            successCount++;
        } else {
            ns.tprint(`WARNING: Failed to download "${file}" (bad path or network error?)`);
        }
    }
    ns.tprint(`INFO: Done. ${successCount}/${files.length} files downloaded.`);
    // Clear any stale temp files from a prior install
    if (ns.fileExists('cleanup.js')) ns.run('cleanup.js');
}
