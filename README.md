# cyguin bitburner scripts

Forked from [Alain Bryden's repo](https://github.com/alainbryden/bitburner-scripts).

## done

- BN12 recursion support. Autopilot stays in the loop (install not destroy), daemon runs xp-only, install at 1 aug. Disabled scripts: host-manager, hacknet-upgrade, contractor, deploy-scripts. Stockmaster gated on API cost.
- BN15 DarkNet support. Autopilot deploys a self-propagating worm to darknet entry servers, pauses daemon during manual labyrinth play, and auto-installs augs when TRP is detected. BN15.1 in the default BN order. Bladeburner and host-manager disabled.
- DarkNet worm solves all 21 server models via interactive solvers. Keys to making this work: AccountsManager_4.2 uses binary search with persisted lo/hi state across restarts, NIL reads positional yes/yesn't feedback, OpenWebAccessPoint extracts clues from heartbleed traffic logs, Pr0verFl0 exploits buffer overflow, Factori-Os uses running product with repeated prime factors, BigMo%od CRT modulo reconstruction, KingOfTheHill three-phase hill climbing on Gaussian peaks. crackers.js handles the 13 static models.
- DarkNet worm stripped to 25KB (imports only crackers.js, not helpers.js). Exec RAM dropped from ~17GB to ~6.5GB to fit within the 16GB limit on depth 0-5 darknet servers.
- Labyrinth solver. BFS maze navigator using `dnet.authenticate()` with direction commands. Worm auto-deploys labyrinth.js to labyrinth servers upon auth.
- Headless. No tail windows by default.
- Dark theme. Paste `cyguin-theme.json` into Bitburner Settings -> Theme Editor.
- Multiplier gating. Stockmaster skips when API costs are absurd. Daemon gates bladeburner, hacknet, and corp internally.

## limitations

- **Darknet propagation speed.** The darknet network mutates every cycle based on `MS_PER_MUTATION_PER_ROW / MilliPerCycle`. At high game speed, servers disconnect faster than auth can complete (interactive solvers take 5-10 seconds per server). Spread to neighbor servers requires the target to be in the source's `serversOnNetwork` at the exact moment `ns.exec()` fires. SCP always works (any distance with session), but exec requires direct connection in the server network topology. If the server moves during auth window, exec returns 0 and spread fails. The worm retries on next cycle.
- **Darknet RAM limits.** Depth 0-5 servers have 16GB max RAM. darknet.js + crackers.js ~6.5GB. Deeper servers have 32GB+.
- **Labyrinth charisma requirement.** Some labyrinth servers require higher charisma than what you have at early installs. The solver retries after each install cycle.
- **BN13/14.** No per-BN strategy logic yet. Both are in the default BN order and fall back to standard daemon behavior.
- **Darknet state corruption.** Rare save-game issue where `DarknetState` becomes corrupted. Only fix is an augment install to regenerate the network.

## quick start

```
run git-pull.js
run autopilot.js
```

## BN15 darknet

The autopilot detects darknet entry servers from home via `dnet.probe()`, authenticates (entry servers are ZeroLogon), scps the worm files, and execs darknet.js on the entry host. The worm propagates by:

1. `dnet.probe()` — find visible darknet neighbors
2. `dnet.authenticate()` — crack password (interactive or static solver)
3. `deployWorm()` — immediate SCP + exec to newly-authed server before mutation cycle disconnects it
4. Each deployed copy opens `.cache` files, runs phishing attacks, and probes its own neighbors

If the player connects to a darknet server, the autopilot detects it and kills the daemon. All modals (casino, install countdowns, faction alerts) are suppressed during darknet play. When TRP is acquired from labyrinth, autopilot installs augments immediately — the check runs on every tick including the darknet path.

## running daemon directly at deep BN12

```
run daemon.js --xp-only --cycle-timing-delay 40 --queue-delay 50 --silent-misfires --recovery-thread-padding 5 --no-tail-windows --reserved-ram 1e+100 --no-share --disable-script /Tasks/contractor.js --disable-script /Tasks/backdoor-all-servers.js --disable-script /Tasks/tor-manager.js --disable-script hacknet-upgrade-manager.js --disable-script host-manager.js --disable-script /Tasks/ram-manager.js
```

## credits

Alain Bryden wrote all the hard code. This fork exists because his scripts are worth building on.
