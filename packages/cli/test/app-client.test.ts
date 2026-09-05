import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

// Tiny DOM fixture: execute the entire shipped client, with deferred HTTP and
// explicit browser lifecycle events. No alternate client implementation.
class Element {
    children: Element[] = [];
    attributes: Record<string, string> = {};
    listeners: Record<string, ((event: any) => unknown)[]> = {};
    parent: Element | null = null;
    ownText = '';
    className = '';
    value = '';
    open = false;
    hidden = false;
    checked = false;
    disabled = false;
    namespaceURI = 'http://www.w3.org/2000/svg';
    constructor(public tag = 'div') {}
    set textContent(text: string) { this.ownText = text; this.children = []; }
    get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(''); }
    append(...nodes: Element[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    prepend(node: Element) { node.parent = this; this.children.unshift(node); }
    replaceChildren(...nodes: Element[]) { this.children = []; this.ownText = ''; this.append(...nodes); }
    replaceWith(node: Element) { if (this.parent) { const at = this.parent.children.indexOf(this); this.parent.children[at] = node; node.parent = this.parent; } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    setAttribute(key: string, value: string) { this.attributes[key] = value; if (key === 'class') this.className = value; }
    addEventListener(name: string, fn: (event: any) => unknown) { (this.listeners[name] ??= []).push(fn); }
    fire(name: string, event: unknown = {}) { return Promise.all((this.listeners[name] ?? []).map(fn => fn(event))); }
    contains(node: Element): boolean { return this === node || this.children.some(child => child.contains(node)); }
    querySelector(selector: string): Element | null { return this.children.find(child => selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : selector.startsWith('#') ? child.attributes.id === selector.slice(1) : child.tag === selector) ?? this.children.map(child => child.querySelector(selector)).find(Boolean) ?? null; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    focus() {}
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const source = readFileSync(new URL('../src/app/ui/client.js', import.meta.url), 'utf8');
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture() {
    const ids = new Map(['main', 'dialog', 'notification', 'navigation', 'view-label', 'refresh'].map(id => [id, new Element()]));
    const document = new Element() as Element & { hidden: boolean; getElementById: (id: string) => Element | null; createElement: (tag: string) => Element; createTextNode: (text: string) => Element; createElementNS: (ns: string, tag: string) => Element };
    document.getElementById = id => ids.get(id) ?? ids.get('main')!.querySelector(`#${id}`);
    document.createElement = tag => new Element(tag);
    document.createTextNode = text => { const node = new Element('text'); node.textContent = text; return node; };
    document.createElementNS = (_ns, tag) => new Element(tag);
    const wordmark = new Element(); wordmark.className = 'wordmark'; document.append(wordmark);
    const window = new Element();
    const requests: { route: string; result: ReturnType<typeof deferred<any>> }[] = [];
    const context = createContext({ document, window, Node: Element, URLSearchParams, AbortController, crypto, Intl, console,
        location: { hash: '', pathname: '/', search: '' }, history: { replaceState() {} },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        setTimeout: () => 1, clearTimeout() {}, setInterval() {},
        fetch: (url: string) => { const result = deferred<any>(); requests.push({ route: url.split('/').at(-1)!, result }); return result.promise; },
    });
    runInContext(source, context);
    const evaluate = <T = any>(code: string): T => runInContext(code, context);
    evaluate(`bearer='synthetic-session'; state.status={vault:{ready:true},visibility_epoch:'1',operations:[]}; state.sources=[{source_key:'source-a',connector_id:'kizuki.markdown-folder',display_name:'markdown-folder',consent:'active',required_fields:['text'],stored:0,errors:0}];`);
    function reply(route: string, data: unknown, status = 200) { const at = requests.findIndex(request => request.route === route); if (at < 0) throw Error(`No pending ${route}`); requests.splice(at, 1)[0]!.result.resolve({ status, json: async () => ({ ok: true, data }) }); }
    return { evaluate, reply, requests, main: ids.get('main')!, dialog: ids.get('dialog')!, notice: ids.get('notification')!, window };
}
const status = (operations: unknown[] = [], epoch = '1') => ({ vault: { ready: true }, visibility_epoch: epoch, operations });

test('Gmail form requires one selected field before requesting enrollment', async () => {
    const f = fixture();
    f.evaluate(`enrollment({id:'gmail',title:'Gmail',detail:'Synthetic',available:true,fields:['text']}); dialog.querySelector('input').checked=false;`);
    await f.evaluate(`dialog.querySelector('form').listeners.submit[0]({preventDefault(){}})`);
    expect(f.dialog.textContent).toContain('Choose at least one kind of information');
    expect(f.requests).toHaveLength(0);
});

test('setup exposes an explicit opt-out and honors launcher preference', () => {
    for (const optedOut of [false, true]) {
        const f = fixture();
        f.evaluate(`state.status={vault:{ready:false},setup_no_service:${optedOut}}; render();`);
        expect(f.main.querySelector('#setup-no-service')?.checked).toBe(optedOut);
        expect(f.main.querySelector('#setup-no-service')?.disabled).toBe(optedOut);
        expect(f.main.textContent).toContain('Turn off background activity for now');
    }
});

test('service observations cannot restore the settings view after session invalidation', async () => {
    const f = fixture();
    f.evaluate(`state.view='settings';`);
    const work = f.evaluate<Promise<void>>('loadService()');
    f.evaluate('disconnect()');
    f.reply('service_status', {state:'active',kind:'systemd',intent:'installed',detail:'STALE_SERVICE',checked_at:'2026-09-05T00:00:00Z'});
    await work;
    expect(f.evaluate('state.service')).toBeNull();
    expect(f.main.textContent).not.toContain('STALE_SERVICE');
});

test('changed epoch immediately removes private DOM and dialogs while refresh is held; late activity cannot restore it', async () => {
    const f = fixture();
    f.evaluate(`state.view='activity'; state.receipts=[{id:'old',page:'PRIVATE_PAGE'}]; render(); privacy(state.sources[0]);`);
    const activity = f.evaluate<Promise<void>>('loadActivity()');
    const pulse = f.evaluate<Promise<void>>('checkVisibility()');
    f.reply('status', status([], '2')); await tick();
    expect(f.main.textContent).not.toContain('PRIVATE_PAGE');
    expect(f.dialog.textContent).toBe('');
    expect(f.dialog.open).toBe(false);
    f.reply('activity', { receipts: [{ id: 'late', page: 'PRIVATE_LATE_PAGE' }] }); await activity;
    expect(f.evaluate('state.receipts')).toHaveLength(0);
    expect(f.main.textContent).not.toContain('PRIVATE_LATE_PAGE');
    f.reply('status', status([], '2')); await tick(); f.reply('catalog', { sources: [] }); f.reply('sources', { sources: [] }); await tick();
    if (f.requests.some(x => x.route === 'activity')) f.reply('activity', { receipts: [] });
    await pulse;
});

test('disconnect and pagehide discard deferred HTTP success and old unauthorized responses', async () => {
    for (const action of ['disconnect()', `window.fire('pagehide')`]) {
        const f = fixture(); f.evaluate(`state.view='activity'; privacy(state.sources[0]);`);
        const work = f.evaluate<Promise<void>>('loadActivity()');
        await f.evaluate(action);
        f.reply('activity', { receipts: [{ page: 'PRIVATE_LATE' }] }); await work;
        expect(f.evaluate('state.receipts')).toHaveLength(0);
        expect(f.dialog.textContent).toBe('');
        expect(f.main.textContent).not.toContain('PRIVATE_LATE');
        expect(f.notice.textContent).toBe('');
    }
    const f = fixture(); const old = f.evaluate<Promise<void>>('loadActivity()'); f.evaluate(`disconnect(); bearer='replacement-session';`);
    f.reply('activity', {}, 401); await old;
    expect(f.evaluate<string>('bearer')).toBe('replacement-session');
});

test('out-of-order activity responses commit only the newest request', async () => {
    const f = fixture();
    const first = f.evaluate<Promise<void>>('loadActivity()'), second = f.evaluate<Promise<void>>('loadActivity()');
    const older = f.requests.shift()!;
    f.reply('activity', { receipts: [{ id: 'current' }] }); await second;
    older.result.resolve({ status: 200, json: async () => ({ ok: true, data: { receipts: [{ id: 'old' }] } }) }); await first;
    expect(f.evaluate<string>('state.receipts[0].id')).toBe('current');
});

test('remove immediately fences in-flight search and clears its private dialog', async () => {
    const f = fixture();
    const search = f.evaluate<Promise<void>>(`search('synthetic')`);
    f.evaluate('privacy(state.sources[0])');
    const findButton = (node: Element): Element | undefined => node.tag === 'button' && node.textContent === 'Remove source' ? node : node.children.map(findButton).find(Boolean);
    const remove = findButton(f.dialog)!; void remove.fire('click');
    f.reply('query', { hits: [{ text: 'REVOKED_LATE_SEARCH' }], degraded: [] }); await search;
    expect(f.evaluate('state.hits')).toBeNull();
    expect(f.main.textContent).not.toContain('REVOKED_LATE_SEARCH');
    expect(f.requests.some(request => request.route === 'revoke')).toBe(true);
});

test('recovered jobs reconcile terminal or missing state without replacing a typed search field', async () => {
    for (const terminal of ['failed', 'succeeded', 'unknown']) {
        const f = fixture();
        f.evaluate(`state.operation={id:'job',kind:'capture',state:'running'}; render();`);
        const field = f.main.querySelector('#memory-query')!; field.value = 'unfinished typing';
        const pulse = f.evaluate<Promise<void>>('checkVisibility()');
        f.reply('status', status(terminal === 'unknown' ? [] : [{ id: 'job', kind: 'capture', state: terminal }])); await pulse;
        expect(f.evaluate<string>('state.operation.state')).toBe(terminal);
        expect(f.main.querySelector('#memory-query')).toBe(field);
        expect(field.value).toBe('unfinished typing');
        expect(f.main.textContent).not.toContain('Working on your source');
    }
});

test('same-provider identity labels expand colliding suffixes and match row and consent/privacy dialogs', () => {
    const f = fixture();
    f.evaluate(`state.view='sources'; state.sources=['first-12345678','second-12345678'].map(source_key=>({...state.sources[0],source_key})); render();`);
    const labels = f.evaluate<string[]>('state.sources.map(sourceLabel)');
    expect(labels[0]).not.toBe(labels[1]);
    for (let i = 0; i < 2; i++) {
        expect(f.main.textContent).toContain(labels[i]!);
        f.evaluate(`consent(state.sources[${i}])`); expect(f.dialog.textContent).toContain(labels[i]!);
        f.evaluate(`privacy(state.sources[${i}])`); expect(f.dialog.textContent).toContain(labels[i]!);
    }
});


test('session invalidation also rejects a response whose JSON body is still pending', async () => {
    const f = fixture(); const work = f.evaluate<Promise<void>>('loadActivity()');
    const body = deferred<unknown>();
    f.requests.shift()!.result.resolve({ status: 200, json: () => body.promise }); await tick();
    f.evaluate('disconnect()');
    body.resolve({ ok: true, data: { receipts: [{ page: 'LATE_BODY_PRIVATE' }] } }); await work;
    expect(f.evaluate('state.receipts')).toHaveLength(0);
    expect(f.main.textContent).not.toContain('LATE_BODY_PRIVATE');
});

test('failed explicit refresh prevents navigation from restoring cached private content', async () => {
    const f = fixture(); f.evaluate(`state.view='activity'; state.receipts=[{page:'PRIVATE_CACHED'}]; render(); privacy(state.sources[0]);`);
    const work = f.evaluate<Promise<void>>('refresh()');
    f.requests.shift()!.result.resolve({ status: 400, json: async () => ({ ok: false, error: { code: 'unavailable' } }) }); await work;
    f.evaluate(`navigate('activity')`);
    expect(f.main.textContent).not.toContain('PRIVATE_CACHED');
    expect(f.dialog.textContent).toBe('');
    expect(f.evaluate('state.receipts')).toHaveLength(0);
});

test('explicit refresh resolves a recovered running operation to its returned terminal receipt', async () => {
    const f = fixture(); f.evaluate(`state.operation={id:'recovered',kind:'capture',state:'running'};`);
    const work = f.evaluate<Promise<void>>('refresh()');
    f.reply('status', status([{id:'recovered',kind:'capture',state:'failed',error:{code:'unavailable'}}])); await tick();
    f.reply('catalog', { sources: [] }); f.reply('sources', { sources: [] }); await work;
    expect(f.evaluate<string>('state.operation.state')).toBe('failed');
    expect(f.main.textContent).toContain('This step needs attention');
});
