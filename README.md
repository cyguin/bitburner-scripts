# cyguin bitburner scripts

Forked from [Alain Bryden's repo](https://github.com/alainbryden/bitburner-scripts). His autopilot is the best there is -- it beats every BN and handles all the mechanics. This fork exists to make it faster.

Goals:

- Less RAM per script. Cut unused imports, redundant checks, and bloat that Insight kept for backwards compat.
- Smarter per-BN decisions. Read BN multipliers and skip mechanics that are mathematically dead (stock market at 730x API cost, bladeburner at 0.14% rank gain).
- BN12 recursion support. Autopilot stays in the loop, daemon runs xp-only, install at 1 aug to chain NFG levels.
- Headless. No tail windows, no DOM hooks, no terminal spam. Script log only.

What I changed so far:

- autopilot.js: three blocks for BN12 (install not destroy, xp-only daemon, 1-aug threshold)
- theme.js: injects cyguin dark theme into the game DOM
- cyguin-theme.css: the CSS

What I haven't touched:

- Everything else. daemon.js, casino.js, helpers.js, gang.js, bladeburner.js, stockmaster.js -- all unchanged from Alain's latest.

## quick start

```
run git-pull.js
run autopilot.js
run theme.js
```

## credits

Alain Bryden wrote all of the difficult code. This fork exists because his scripts are that good and worth building on.
