import { hashCode, pathJoin, formatDuration } from './format.js'

const subfolder = '';
export function getFilePath(file) { return pathJoin(subfolder, file); }

export function checkNsInstance(ns, callerName) {
    if (typeof ns.run !== 'function') throw new Error(`${callerName} was not passed a valid ns instance`);
    return ns;
}

export const log = (ns, msg, printToTerminal = false, customLog = undefined) => {
    if (customLog) customLog(msg);
    else if (printToTerminal) ns.tprint(msg);
    else ns.print(msg);
};

export function tail(ns, msg) { try { ns.ui.openTail(); } catch {} if (msg) ns.print(msg); }

export function jsonReplacer(key, val) {
    if (val === Infinity) return { $type: 'number', $value: 'Infinity' };
    if (val === -Infinity) return { $type: 'number', $value: '-Infinity' };
    if (Number.isNaN(val)) return { $type: 'number', $value: 'NaN' };
    if (typeof val === 'bigint') return { $type: 'bigint', $value: val.toString() };
    if (val instanceof Map) return { $type: 'Map', $value: [...val] };
    if (val instanceof Set) return { $type: 'Set', $value: [...val] };
    return val;
}

export function jsonReviver(key, val) {
    if (val == null || typeof val !== 'object' || val.$type == null) return val;
    if (val.$type === 'number') return Number.parseFloat(val.$value);
    if (val.$type === 'bigint') return BigInt(val.$value);
    if (val.$type === 'Map') return new Map(val.$value);
    if (val.$type === 'Set') return new Set(val.$value);
    return val;
}

export function getErrorInfo(e) {
    return typeof e === 'string' ? e : (e?.message ?? JSON.stringify(e, jsonReplacer));
}

export function unEscapeArrayArgs(s) {
    if (typeof s === 'string' && s.startsWith('[') && s.endsWith(']')) {
        try { return JSON.parse(s); } catch { return s; }
    }
    return s;
}

export async function dynamicRun(ns, command, args = [], threads = 1) {
    const fName = `/Temp/dyn_${Math.abs(hashCode(command)) % 0xFFFFFFFFFFF}.js`;
    const script = `export async function main(ns) { ${command} }`;
    if (ns.read(fName) !== script) ns.write(fName, script, "w");
    return ns.run(fName, { temporary: true, threads }, ...args);
}

export async function autoRetry(ns, fn, fnSuccess, errorCtx = "Condition not met",
    maxRetries = 5, delayMs = 50, backoff = 3, verbose = false) {
    let attempts = 0, curDelay = delayMs;
    while (attempts++ <= maxRetries) {
        if (attempts > 1) { await ns.sleep(curDelay); curDelay *= backoff; }
        try {
            const result = await fn();
            let ok = fnSuccess(result);
            if (ok instanceof Promise) ok = await ok;
            if (ok) return result;
            if (attempts >= maxRetries) throw new Error(typeof errorCtx === 'string' ? errorCtx : errorCtx(result));
            if (verbose) ns.print(`Retry ${attempts}/${maxRetries} failed, retrying in ${curDelay}ms`);
        } catch (e) {
            if (attempts >= maxRetries) throw e;
            if (verbose) ns.print(`Retry ${attempts}/${maxRetries} error: ${getErrorInfo(e)}`);
        }
    }
}

export async function waitForProcessToComplete(ns, pid, verbose = false) {
    let start = Date.now();
    for (let i = 0; i < 1000; i++) {
        if (!ns.isRunning(pid)) return;
        if (verbose && i % 100 === 0) ns.print(`Waiting for pid ${pid}... (${formatDuration(Date.now() - start)})`);
        await ns.sleep(Math.min(Math.pow(2, i), 200));
    }
    throw new Error(`Process ${pid} exceeded max wait time`);
}

export function tprintTable(ns, rows, headers) {
    if (!rows.length) { ns.tprint("(no data)"); return; }
    const colWidths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i] || '').length)));
    const formatRow = row => row.map((v, i) => String(v).padEnd(colWidths[i])).join(' | ');
    ns.tprint(headers.map((h, i) => h.padEnd(colWidths[i])).join(' | '));
    ns.tprint(colWidths.map(w => '-'.repeat(w)).join('-|-'));
    for (const row of rows) ns.tprint(formatRow(row));
}
