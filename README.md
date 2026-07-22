# cyguin bitburner scripts

Forked from [Alain Bryden's repo](https://github.com/alainbryden/bitburner-scripts).

## done

- BN12 recursion support. Autopilot stays in the loop (install not destroy), daemon runs xp-only, install at 1 aug. Disabled scripts: host-manager, hacknet-upgrade, contractor, deploy-scripts. Stockmaster gated on API cost.
- BN15 DarkNet support. Autopilot deploys a self-propagating worm to darknet entry servers, pauses daemon during manual labyrinth play, and auto-installs augs when TRP is detected. BN15.1 in the default BN order. Bladeburner and host-manager disabled (0.2x rank, 0.6x hack).
- DarkNet worm solves 20 of 21 server models. Interactive solvers for AccountsManager_4.2 (binary search), DeepGreen (mastermind), NIL (positional feedback), OpenWebAccessPoint (heartbleed clue extraction), Pr0verFl0 (buffer overflow), Factori-Os (prime factorization), BigMo%od (CRT modulo reconstruction). crackers.js handles the remaining 13 static models.
- Headless. No tail windows by default.
- Dark theme. Paste `cyguin-theme.json` into Bitburner Settings -> Theme Editor.
- Multiplier gating. Stockmaster skips when API costs are absurd. Daemon gates bladeburner, hacknet, and corp internally.

## planned

- BN13/14 autopilot strategy logic. Both are already in the default BN order.
- KingOfTheHill solver. The only darknet model not yet automated (rare gradient-ascent puzzle).
- RAM audit. Cut unused imports and backwards-compat bloat.

## quick start

```
run git-pull.js
run autopilot.js
```

## BN15 darknet

The autopilot detects darknet entry servers from home, scps the worm (`darknet.js`, `darknet-looter.js`, `darknet-virus.js`, `crackers.js`), and execs it on the entry host. The worm then propagates deeper by authenticating with each visible darknet server and copying itself. Each copy opens `.cache` files and runs phishing attacks.

If the player manually connects to a darknet server, the autopilot detects it and kills the daemon so it doesn't interfere with labyrinth exploration or manual play.

When TRP is acquired from the labyrinth, autopilot installs augmentations within seconds to lock it in.

## running daemon directly at deep BN12

```
run daemon.js --xp-only --cycle-timing-delay 40 --queue-delay 50 --silent-misfires --recovery-thread-padding 5 --no-tail-windows --reserved-ram 1e+100 --no-share --disable-script /Tasks/contractor.js --disable-script /Tasks/backdoor-all-servers.js --disable-script /Tasks/tor-manager.js --disable-script hacknet-upgrade-manager.js --disable-script host-manager.js --disable-script /Tasks/ram-manager.js
```

At deep recursion `optimizePerformanceMetrics` always converges to 0% steal (server money rounds to 0). Log spam is cosmetic. Daemon still earns XP and preps targets.

## credits

Alain Bryden wrote all the hard code. This fork exists because his scripts are worth building on.

## on ram optimization

Alain's code is already highly optimized. There isn't much to cut.

Key patterns he uses that save RAM:

- **`getNsDataThroughFile`** — runs expensive ns calls on remote servers instead of home. The ns API charges RAM based on which script calls it, so a 1.6GB throwaway script on n00dles is cheaper than adding that cost to daemon.js. Most data reads (player info, server stats, source files) use this.

- **`arbitraryExecution`** — distributes hack/grow/weaken threads across all rooted servers sorted by free RAM. Not just home. At deep BN12 the daemon uses 2.24TB of network RAM, not 64GB of home RAM.

- **`launchScriptHelper`** — only starts scripts when there's enough RAM. Checks minRamReq, kills lower-priority scripts if needed, and copies dependencies to remote hosts automatically.

- **`optimizePerformanceMetrics`** — binary-searches the optimal steal percentage for each target given current network RAM. At normal scale this is essential. At BN12-333 it always converges to 0% (server money rounds to nothing) and the 1000-iteration loop becomes cosmetic noise.

Most of the daemon's RAM cost is the source code itself (2.6GB), not what it launches. The helpers.js library is shared across all scripts so the import cost amortizes. Cutting individual helper functions from helpers.js saves almost nothing in practice — Bitburner charges RAM based on source character count, not import scope.
