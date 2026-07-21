const argsSchema = [
    ['dev', false],
    ['bypass', false],
    ['reality', false],
    ['rainbow', ''],
];

export function autocomplete(data, args) { data.flags(argsSchema); return []; }

export async function main(ns) {
    const opts = ns.flags(argsSchema);

    if (opts.dev) {
        const origCE = React.createElement;
        const origState = React.useState;
        let stateCalls = 0, resolve;
        const nextLevelHook = (cn, fn, pt, pa) => {
            React.createElement = origCE;
            const w = new Proxy(fn, {
                apply(t, ta, a) {
                    if (stateCalls === 0) {
                        React.useState = function (...args) {
                            stateCalls++;
                            const s = origState.call(this, ...args);
                            if (stateCalls === cn) { resolve(s); React.useState = origState; }
                            return s;
                        };
                    }
                    return t.apply(ta, a);
                }
            });
            return origCE.call(pt, w, ...pa.slice(1));
        };
        React.createElement = function (...args) {
            const fn = args[0];
            const s = typeof fn === 'function' ? String(fn) : null;
            if (s?.includes('Trying to go to a page without the proper setup'))
                return nextLevelHook(2, fn, this, args);
            if (s?.includes('Routing is currently disabled'))
                return nextLevelHook(1, fn, this, args);
            return origCE.call(this, ...args);
        };
        try {
            const rp = Promise.race([
                new Promise(r => resolve = r),
                ns.asleep(5000).then(() => { throw Error('timeout'); })
            ]).finally(() => { React.createElement = origCE; React.useState = origState; });
            ns.ui.setTheme(ns.ui.getTheme());
            const [st, setSt] = await rp;
            if (typeof st === 'string') setSt('Dev');
            else if (typeof st === 'number') setSt(8);
            else if (Array.isArray(st)) setSt([{ page: 'Dev' }, ...st]);
        } catch (e) { ns.tprint(`Dev: ${e?.message || e}`); }
        return;
    }

    if (opts.bypass) {
        const d = eval('document');
        d.completely_unused_field = undefined;
        const rd = document;
        rd.completely_unused_field = undefined;
        rd.completely_unused_field = true;
        const ok = d.completely_unused_field;
        d.completely_unused_field = undefined;
        rd.completely_unused_field = undefined;
        ns.tprint(ok ? 'Bypass OK (check achievements)' : 'Bypass failed');
        return;
    }

    if (opts.reality) {
        let x = false;
        (function r(d) { if (d) return; x = !x; r(d - 1); })(2);
        ns.tprint(x ? 'Reality altered!' : 'Reality false (expected)');
        return;
    }

    if (opts.rainbow) {
        try {
            const b = eval('require("bcryptjs")');
            const ok = b.compareSync(opts.rainbow,
                '$2a$10$aertxDEkgor8baVtQDZsLuMwwGYmkRM/ohcA6FjmmzIHQeTCsrCcO');
            ns.tprint(ok ? 'Rainbow matched!' : 'Wrong guess');
        } catch { ns.tprint('Rainbow check failed'); }
        return;
    }

    ns.tprint('Usage:');
    ns.tprint('  run cheat-tool.js --dev          Open dev menu');
    ns.tprint('  run cheat-tool.js --bypass       DOM bypass exploit');
    ns.tprint('  run cheat-tool.js --reality      Reality alter exploit');
    ns.tprint('  run cheat-tool.js --rainbow <s>  Rainbow guess');
}
