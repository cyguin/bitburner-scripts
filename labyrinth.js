import { getConfiguration, log } from './helpers.js'

const argsSchema = [
    ['interval', 100],
    ['max-attempts', 5000],
];

export function autocomplete(data) { return ['--tail']; }

export async function main(ns) {
    let dnet, opts;
    try { dnet = ns.dnet; opts = getConfiguration(ns, argsSchema); } catch { return; }
    if (!dnet) return;
    ns.disableLog('ALL');
    log(ns, `labyrinth on ${ns.getHostname()}`);

    const directions = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
    let visited = new Set();

    for (let i = 0; i < opts['max-attempts']; i++) {
        const r = dnet.labreport();
        if (!r || !r.success) { await ns.sleep(opts.interval); continue; }

        const [x, y] = r.coords;
        const key = `${x},${y}`;
        visited.add(key);

        log(ns, `${x},${y} N:${r.north} S:${r.south} E:${r.east} W:${r.west}`);

        // Try each direction, preferring unvisited neighbors
        const moves = Object.entries(directions)
            .filter(([dir]) => r[dir])
            .map(([dir, [dx, dy]]) => {
                const nx = x + dx, ny = y + dy;
                const nk = `${nx},${ny}`;
                return { dir, dx, dy, nx, ny, visited: visited.has(nk) };
            })
            .sort((a, b) => a.visited - b.visited);

        if (!moves.length) { log(ns, `stuck at ${x},${y}`); break; }

        // Move to best direction
        const move = moves[0];
        const result = await dnet.authenticate(ns.getHostname(), move.dir);
        if (result.success) {
            log(ns, `LAB COMPLETE`);
            break;
        }
        await ns.sleep(opts.interval);
    }
}
