export async function main(ns) {
    const css = ns.read('cyguin-theme.css');
    if (!css) return ns.tprint('ERROR: cyguin-theme.css not found');
    const doc = eval('document');
    const el = doc.getElementById('cyguin-theme');
    if (el) el.remove();
    const s = doc.createElement('style');
    s.id = 'cyguin-theme';
    s.textContent = css;
    doc.head.appendChild(s);
    ns.tprint('theme applied');
}
