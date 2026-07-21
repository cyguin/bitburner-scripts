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
