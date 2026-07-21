# cyguin bitburner scripts

Forked from [Alain Bryden's repo](https://github.com/alainbryden/bitburner-scripts).

## done

- BN12 recursion support. Autopilot stays in the loop (install not destroy), daemon runs xp-only, install at 1 aug to chain NFG levels.
- Headless. No tail windows by default.
- Dark theme. theme.js injects cyguin-theme.css into the game DOM.

## planned

- Smarter per-BN decisions. Read BN multipliers from the game engine and skip mechanics that are mathematically dead at scale.
- RAM reduction. Cut unused imports, redundant checks, and backwards-compat bloat.

## quick start

```
run git-pull.js
run autopilot.js
run theme.js
```

## credits

Alain Bryden wrote all the hard code. This fork exists because his scripts are worth building on.
