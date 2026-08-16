# cyguin bitburner scripts

Forked from [Alain Bryden's repo](https://github.com/alainbryden/bitburner-scripts).

## done

- BN12 recursion support. Autopilot stays in the loop: installs queued augs, then rejoins via `destroyW0r1dD43m0n(12)` once the queue is empty (each rejoin = +1 SF12, no max). Daemon runs xp-only targeting w0r1d_d43m0n. Disabled scripts: host-manager, hacknet-upgrade, contractor, deploy-scripts. Stockmaster gated on API cost.
- BN15 DarkNet support. Autopilot deploys a self-propagating worm to darknet entry servers, pauses daemon during manual labyrinth play, and auto-installs augs when TRP is detected. BN15.1 in the default BN order. Bladeburner and host-manager disabled.
- DarkNet worm has solvers for all 21 server models (interactive + static). Keys to making this work: AccountsManager_4.2 binary search with persisted lo/hi state, NIL positional yes/yesn't feedback, OpenWebAccessPoint heartbleed clue extraction, Pr0verFl0 buffer overflow, Factori-Os running product with repeated prime factors, BigMo%od CRT modulo reconstruction, KingOfTheHill three-phase hill climbing. crackers.js handles the 13 static models. Note: solver reliability at scale is untested — propagation is the real bottleneck.
- DarkNet worm stripped to 25KB (imports only crackers.js, not helpers.js). Exec RAM dropped from ~17GB to ~6.5GB to fit within the 16GB limit on depth 0-5 darknet servers.
- Labyrinth solver. BFS maze navigator using `dnet.authenticate()` with direction commands. Worm auto-deploys labyrinth.js to labyrinth servers upon auth.
- Headless. No tail windows by default.
- Dark theme. Paste `cyguin-theme.json` into Bitburner Settings -> Theme Editor.
- Multiplier gating. Stockmaster skips when API costs are absurd. Daemon gates bladeburner, hacknet, and corp internally.

## limitations

- **BN15 is not complete.** Darknet worm propagation, labyrinth solving, and the full augment-to-WD cycle need more testing. Server mutation timing, RAM limits on depth 0-5 servers, and solver reliability at scale are all areas that regress unpredictably. Do not expect a clean hands-off BN15 run yet.
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

## BN12 recursion

BN12 (The Recursion) is the endgame loop. Destroying it upgrades Source-File 12 with **no max level**, and each SF12 level starts you with +1 NeuroFlux Governor. The default BN order ends with `12.9999` ("keep playing forever"), so autopilot stays in the loop:

1. **Daemon runs `--xp-only` targeting w0r1d_d43m0n** to farm hack XP. At deep recursion levels money is worthless (hack income is ~0.14% of server money), so XP is the only thing that matters.
2. **Augs queued?** Autopilot installs them (plain prestige within BN12, keeps purchases) and relaunches.
3. **Queue empty + BN complete** (hack level >= WD requirement and WD rooted): autopilot calls `destroyW0r1dD43m0n(12)` — this auto-rejoins BN12, bumps SF12 by 1, and relaunches autopilot. No manual hack/rejoin step needed.
4. Repeat forever.

The WD hack requirement grows each cycle: `3000 * 1.02^(SF12+1)` (e.g. ~2.28M at BN12.335, ~2.32M at BN12.336). Each rejoin's NFG level more than pays for the ~2% difficulty creep.

Deep-BN12 tweaks:
- Sleeves launch with `--training-reserve 0` so they train/study immediately — BN12 starts with $0, so the usual casino seed-money reserve would idle them in shock recovery.
- Disabled as useless at deep recursion: host-manager, hacknet-upgrade-manager, contractor, deploy-scripts. Stockmaster gated on API cost.
- Gotcha: the loop used to gate the reset on having augs queued and silently idle once the queue emptied — the recursion stalled at a fixed BN12.x. The rejoin is the reset now; an empty queue means "rejoin", not "wait".

## running daemon directly at deep BN12

```
run daemon.js --xp-only --cycle-timing-delay 40 --queue-delay 50 --silent-misfires --recovery-thread-padding 5 --no-tail-windows --reserved-ram 1e+100 --no-share --disable-script /Tasks/contractor.js --disable-script /Tasks/backdoor-all-servers.js --disable-script /Tasks/tor-manager.js --disable-script hacknet-upgrade-manager.js --disable-script host-manager.js --disable-script /Tasks/ram-manager.js
```

## credits

Alain Bryden wrote all the hard code. This fork exists because his scripts are worth building on.
