import { getCandidates, MAX_CRACK_ATTEMPTS } from './crackers.js';


async function ensureSession(ns, dnet, host, cache) {
  let det;
  try { det = dnet.getServerDetails(host); } catch { return false; }
  if (det.hasSession) return true;
  const hint = det.passwordHint || "", pwLen = Math.max(1, det.passwordLength || 1);
  const model = det.modelId || "defaultModel";
  const data = det.data ?? '';
  const tryPw = async (pw) => {
    const t = pw.slice(0, Math.min(pwLen, 50));
    try {
      const r = await dnet.authenticate(host, t);
      if (r.success) { try { dnet.connectToSession?.(host, t); } catch {} cache[host] = t; return true; }
    } catch {}
    return false;
  };
  if (cache[host] && await tryPw(cache[host])) return true;
  delete cache[host];
  const candidates = getCandidates(model, hint, pwLen, data).slice(0, MAX_CRACK_ATTEMPTS);
  for (const pw of candidates) {
    if (await tryPw(pw)) return true;
    await ns.sleep(150);
  }
  return false;
}

function bfs(report, radar, blocked) {
  const grid = parseRadar(radar?.message);
  if (!grid) return [];
  const start = findChar(grid, "@"), end = findChar(grid, "X");
  if (!start || !end) return [];
  const DIRS = ["north","east","south","west"];
  const h = grid.length, w = grid[0].length, DR = [-1,0,1,0], DC = [0,1,0,-1];
  const q = [[start[0], start[1], []]], vis = new Set([start[0]+","+start[1]]);
  while (q.length) {
    const [r, c, path] = q.shift();
    if (r === end[0] && c === end[1]) return path;
    for (let i = 0; i < 4; i++) {
      const nr = r+DR[i], nc = c+DC[i];
      if (nr<0||nr>=h||nc<0||nc>=w) continue;
      if (grid[nr][nc]==="\u2588") continue;
      if (blocked.has(DIRS[i])) continue;
      const k = nr+","+nc;
      if (vis.has(k)) continue;
      vis.add(k);
      q.push([nr, nc, [...path, DIRS[i]]]);
    }
  }
  return [];
}
function parseRadar(msg) {
  if (!msg) return null;
  const lines = msg.split("\n").filter(l => l.includes("\u2588")||l.includes("@")||l.includes("X")||l.includes(" "));
  return lines.length < 3 ? null : lines.map(l => [...l]);
}
function findChar(grid, ch) {
  for (let r=0;r<grid.length;r++) for (let c=0;c<grid[r].length;c++) if (grid[r][c]===ch) return [r,c];
  return null;
}


const argsSchema = [
    ['terminal', false],
];

export function autocomplete(data, args) { data.flags(argsSchema); return []; }

export async function main(ns) {
  ns.disableLog("ALL");
  const opts = ns.flags(argsSchema);
  const dnet = ns.dnet;
  const tlog = opts.terminal ? (msg) => ns.tprint(msg) : (msg) => ns.print(msg);
  if (!dnet) { ns.tprint("Darknet API not available"); return; }

  const PW_FILE = "/data/dnet-passwords.json";
  const HOME = "home";

  function loadCache() {
    try { ns.scp(PW_FILE, ns.getHostname(), HOME); } catch {}
    try { return JSON.parse(ns.read(PW_FILE) || "{}"); } catch { return {}; }
  }
  function saveCache(c) {
    try { ns.write(PW_FILE, JSON.stringify(c), "w"); } catch {}
    try { ns.scp(PW_FILE, HOME); } catch {}
  }

  let labHost = null, prevDepth = 0, prevDiff = 0;
  let sessionOk = false, solved = false;
  let cache = loadCache();
  let seenHosts = new Set();
  let maxDepthReached = 0;

  tlog("labyrinth.js starting — crawling darknet for labyrinths...");

  while (true) {
    try {
      const here = ns.getHostname();

      if (!labHost) {
        if (dnet.isDarknetServer(here)) {
          const labCandidates = dnet.probe().filter(n => {
            try { return dnet.getServerDetails(n).isStationary; } catch { return false; }
          }).filter(n => {
            try { return dnet.getDepth(n) >= prevDepth + 4; } catch { return false; }
          }).filter(n => {
            try { return (dnet.getServerDetails(n).difficulty || 0) > prevDiff; } catch { return false; }
          });

          if (labCandidates.length > 0) {
            labHost = labCandidates[0];
            prevDepth = dnet.getDepth(labHost);
            prevDiff = dnet.getServerDetails(labHost).difficulty || 0;
            tlog(`Found labyrinth: ${labHost} at depth ${prevDepth}`);
          }
        }

      if (!labHost) {
        const hereOk = dnet.isDarknetServer(here);

        if (!hereOk) {
          const dnetEntry = dnet.probe().find(n => dnet.isDarknetServer(n));
          if (dnetEntry) { try { ns.singularity.connect(dnetEntry); await ns.sleep(300); continue; } catch {} }
          await ns.sleep(5000);
          continue;
        }

        const depths = hereOk ? dnet.getDepth(here) : 0;
        if (depths > maxDepthReached) {
          maxDepthReached = depths;
          tlog(`Depth ${depths}`);
        }
        seenHosts.add(here);

        const allProbes = dnet.probe();

        const lab = allProbes.filter(n => {
          try {
            const det = dnet.getServerDetails(n);
            return det.isStationary && dnet.getDepth(n) >= prevDepth + 4 && (det.difficulty || 0) > prevDiff;
          } catch { return false; }
        });
        if (lab.length > 0) {
          labHost = lab[0];
          prevDepth = dnet.getDepth(labHost);
          prevDiff = dnet.getServerDetails(labHost).difficulty || 0;
          tlog(`Labyrinth found: ${labHost} at depth ${prevDepth}`);
          break;
        }

        const targets = allProbes.filter(n => {
          try {
            const det = dnet.getServerDetails(n);
            return det.isOnline && det.isConnectedToCurrentServer && !det.isStationary;
          } catch { return false; }
        }).sort((a, b) => {
          try { return dnet.getDepth(b) - dnet.getDepth(a); } catch { return 0; }
        });

        let moved = false;
        for (const target of targets) {
          if (seenHosts.has(target)) continue;
          const depth = dnet.getDepth(target);
          const ok = await ensureSession(ns, dnet, target, cache);
          if (ok) {
            saveCache(cache);
            seenHosts.add(target);
            try {
              ns.singularity.connect(target);
              await ns.sleep(300);
              moved = true;
              if (depth > maxDepthReached) tlog(`Moved to ${target} depth ${depth}`);
              break;
            } catch {}
          }
        }

        if (!moved) {
          if (dnet.isDarknetServer(here)) {
            tlog(`Stuck at depth ${maxDepthReached}. Mutating.`);
            try { await dnet.nextMutation(); } catch {}
          }
        }
          await ns.sleep(3000);
          continue;
        }
      }

      if (!sessionOk) {
        const before = Object.keys(cache).length;
        sessionOk = await ensureSession(ns, dnet, labHost, cache);
        if (!sessionOk) {
          tlog(`Could not auth ${labHost}`);
          labHost = null;
          try { await dnet.nextMutation(); } catch {}
          await ns.sleep(10000);
          continue;
        }
        if (Object.keys(cache).length > before) saveCache(cache);
        tlog(`Authenticated on labyrinth: ${labHost}`);
      }

      tlog(`\n=== LABYRINTH: ${labHost} (depth ${prevDepth}) ===`);
      tlog(`Connect: connect ${labHost}`);
      tlog(`Then type: north / south / east / west`);
      tlog("");

      while (!solved) {
        const report = dnet.labreport();
        if (!report.success) { tlog(`Error: ${report.message}`); break; }
        const radar = dnet.labradar();
        if (radar?.success) ns.print(radar.message);

        if (report.data?.atExit) {
          tlog("=== AT EXIT! Opening caches... ===");
          for (const f of ns.ls(ns.getHostname(), ".cache")) try { await dnet.openCache(f); } catch {}
          solved = true;
          break;
        }

        const blocked = new Set();
        const path = bfs(report, radar, blocked);
        if (path.length > 0) {
          tlog(`BFS path: ${path.join(" \u2192 ")}`);
          tlog(`Try: go ${path[0]}`);
        } else {
          tlog("BFS: dead end? Check manual.");
        }
        await ns.sleep(5000);
      }

      if (solved) {
        tlog(`Labyrinth ${labHost} solved. Looking for next...`);
        labHost = null;
        sessionOk = false;
        solved = false;
        seenHosts.clear();
      }
    } catch (e) {
      tlog(`Error: ${e.message}`);
      await ns.sleep(5000);
    }
  }
}
