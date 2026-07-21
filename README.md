# cyguin bitburner scripts

Forked from [Alain Bryden's repo](https://github.com/alainbryden/bitburner-scripts).

## done

- BN12 recursion support. Autopilot stays in the loop (install not destroy), daemon runs xp-only, install at 1 aug.
- BN15 DarkNet support. Autopilot launches darknet scripts, and BN15.1 is in the default order.
- Headless. No tail windows by default.
- Dark theme. theme.js injects cyguin-theme.css into the game DOM.
- Multiplier gating. Stockmaster skips when API costs are absurd. Daemon already gates bladeburner/hacknet/corp internally.

## planned

- BN13/14 autopilot support. Both are already in the default BN order but need per-BN strategy logic.
- RAM reduction. Cut unused imports and backwards-compat bloat.
- BN12 daemon tweaks. Handle 0.14% ServerWeakenRate edge cases at deep recursion.

## quick start

```
run git-pull.js
run autopilot.js
run theme.js
```

## running daemon directly at deep BN12

If autopilot isn't managing the daemon, use these flags to skip useless tools:

```
run daemon.js --xp-only --cycle-timing-delay 40 --queue-delay 50 --silent-misfires --recovery-thread-padding 5 --no-tail-windows --reserved-ram 1e+100 --no-share --disable-script /Tasks/contractor.js --disable-script /Tasks/backdoor-all-servers.js --disable-script /Tasks/tor-manager.js --disable-script hacknet-upgrade-manager.js --disable-script host-manager.js --disable-script /Tasks/ram-manager.js
```

At deep recursion ServerMaxMoney rounds to near-zero, so `optimizePerformanceMetrics` always converges to 0% steal. The "Tuned 0% steal" log spam is cosmetic but harmless. Daemon still earns XP and preps targets correctly.

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

The bottom line: if it seems like the daemon should be leaner, it probably can't be. Alain already did that work. The fork's goal is to add BN12-15 awareness and skip scripts that are mathematically dead at scale, not to shrink the core engine.
