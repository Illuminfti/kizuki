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
    document.getElementById = id => ids.get(id) ?? ids.get('main')!.querySelector(`#${id}`) ?? ids.get('dialog')!.querySelector(`#${id}`);
    document.createElement = tag => new Element(tag);
    document.createTextNode = text => { const node = new Element('text'); node.textContent = text; return node; };
    document.createElementNS = (_ns, tag) => new Element(tag);
    const wordmark = new Element(); wordmark.className = 'wordmark'; document.append(wordmark);
    const window = new Element();
    const requests: { route: string; payload: any; result: ReturnType<typeof deferred<any>> }[] = [];
    const storageWrites: string[] = [];
    const clipboardWrites: string[] = [];
    const context = createContext({ document, window, Node: Element, URLSearchParams, AbortController, TextEncoder, crypto, Intl, console,
        navigator: { clipboard: { async writeText(value: string) { clipboardWrites.push(value); } } },
        location: { hash: '', pathname: '/', search: '' }, history: { replaceState() {} },
        sessionStorage: { getItem: () => null, setItem(key: string, value: string) { storageWrites.push(`${key}=${value}`); }, removeItem() {} },
        setTimeout: () => 1, clearTimeout() {}, setInterval() {},
        fetch: (url: string, options: { body: string }) => { const result = deferred<any>(); requests.push({ route: url.split('/').at(-1)!, payload: JSON.parse(options.body), result }); return result.promise; },
    });
    runInContext(source, context);
    const evaluate = <T = any>(code: string): T => runInContext(code, context);
    evaluate(`bearer='synthetic-session'; state.status={vault:{ready:true},visibility_epoch:'1',operations:[]}; state.sources=[{source_key:'source-a',connector_id:'kizuki.markdown-folder',display_name:'markdown-folder',consent:'active',required_fields:['text'],stored:0,errors:0}];`);
    function reply(route: string, data: unknown, status = 200) { const at = requests.findIndex(request => request.route === route); if (at < 0) throw Error(`No pending ${route}`); requests.splice(at, 1)[0]!.result.resolve({ status, json: async () => ({ ok: true, data }) }); }
    return { evaluate, reply, requests, storageWrites, clipboardWrites, main: ids.get('main')!, dialog: ids.get('dialog')!, notice: ids.get('notification')!, window };
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

test('setup does not promise background updates when the host has no supervisor', () => {
    const f = fixture();
    f.evaluate(`state.status={vault:{ready:false},setup_supervisor:'none',setup_no_service:false}; render();`);
    expect(f.main.textContent).toContain('Background activity is unavailable on this device');
    expect(f.main.textContent).not.toContain('even after you close the app');
});

test('partial initialization refreshes the saved vault and opens background recovery in Settings', async () => {
    const f = fixture();
    f.evaluate(`state.status={vault:{ready:false},visibility_epoch:'uninitialized',operations:[]}; render();`);
    const work = f.evaluate<Promise<void>>('initialize()');
    f.reply('initialize', { operation_id: 'init' }); await tick();
    const job = {id:'init',kind:'initialize',state:'failed',error:{code:'service_unavailable'}};
    f.reply('operation', job); await tick();
    f.reply('status', status([job], 'ready')); await tick();
    f.reply('catalog', { sources: [] }); f.reply('sources', { sources: [] }); await tick();
    if (f.requests.some(request => request.route === 'service_status')) f.reply('service_status', {state:'absent',kind:'systemd',intent:'unknown',detail:'Enable background activity to retry.',checked_at:'2026-09-05T00:00:00Z'});
    await work; await tick();
    expect(f.evaluate<boolean>('state.status.vault.ready')).toBe(true);
    expect(f.evaluate<string>('state.view')).toBe('settings');
    expect(f.main.textContent).toContain('Enable background activity');
    expect(f.notice.textContent).toContain('workspace is saved');
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

const modelStatus = (revision = 'model-1') => ({ revision, selection: { kind: 'openai_compatible', base_url: 'https://synthetic.invalid/v1', model: 'test-model', model_endpoint: 'https://synthetic.invalid/v1/chat/completions' }, credential: 'configured', last_test: null });
async function openModel(f: ReturnType<typeof fixture>) {
    const work = f.evaluate<Promise<void>>('modelSettings()');
    f.reply('model_status', modelStatus()); await work;
}
function findAction(node: Element, label: string): Element {
    const found = node.tag === 'button' && node.textContent === label ? node : node.children.map(child => { try { return findAction(child, label); } catch { return null; } }).find(Boolean);
    if (!found) throw Error(`Missing action ${label}`);
    return found;
}

test('model save sends exact revision and transient replacement key without testing or granting a source', async () => {
    const f = fixture(); await openModel(f);
    const key = f.dialog.querySelector('#model-key')!; key.value = 'SYNTHETIC_KEY';
    const save = f.dialog.querySelector('form')!.fire('submit', { preventDefault() {} }); await tick();
    expect(key.value).toBe('');
    expect(f.requests.map(x => x.route)).toEqual(['model_save']);
    expect(f.requests[0]!.payload).toEqual({ expected_revision: 'model-1', selection: { kind: 'openai_compatible', base_url: 'https://synthetic.invalid/v1', model: 'test-model' }, credential: { action: 'replace', value: 'SYNTHETIC_KEY' } });
    f.reply('model_save', modelStatus('model-2')); await save;
    expect(f.storageWrites).toHaveLength(0);
    expect(JSON.stringify(f.evaluate('state'))).not.toContain('SYNTHETIC_KEY');
    expect(f.dialog.textContent + f.main.textContent + f.notice.textContent).not.toContain('SYNTHETIC_KEY');
    expect(f.notice.textContent).toContain('No source permission');
});

test('model key clears on panel closure, Escape, off selection and privacy invalidation', async () => {
    for (const action of ['closeDialog()', `dialog.fire('cancel')`, `dialog.querySelector('#model-kind').value='none'; dialog.querySelector('#model-kind').fire('change')`, 'disconnect()', 'invalidatePrivateView()', `window.fire('pagehide')`]) {
        const f = fixture(); await openModel(f);
        const key = f.dialog.querySelector('#model-key')!; key.value = 'SYNTHETIC_KEY';
        await f.evaluate(action);
        expect(key.value).toBe('');
        expect(f.storageWrites).toHaveLength(0);
    }
});

test('synthetic model test is explicit and binds only the saved revision', async () => {
    const f = fixture(); f.evaluate(`state.model=${JSON.stringify(modelStatus())}; state.view='settings'; render();`);
    expect(f.requests).toHaveLength(0);
    const work = findAction(f.main, 'Test connection').fire('click'); await tick();
    expect(f.requests[0]!.route).toBe('model_test');
    expect(f.requests[0]!.payload).toEqual({ expected_revision: 'model-1' });
    expect(f.dialog.textContent).toContain('made-up prompt');
    f.reply('model_test', { operation_id: 'test' }); await tick();
    f.reply('operation', { id: 'test', kind: 'model_test', state: 'succeeded' }); await tick();
    f.reply('model_status', { ...modelStatus(), last_test: { revision: 'model-1', at: '2026-09-07T12:00:00Z', outcome: 'succeeded', latency_ms: 12, error_code: null } }); await work;
    expect(f.main.textContent).toContain('Connection test passed');
});

test('source model permission binds exact model and source revisions, separately from capture', async () => {
    const f = fixture(); f.evaluate(`state.sources[0].revision='source-1'; state.sources[0].model_consent='different_model';`);
    const open = f.evaluate<Promise<void>>('modelConsent(state.sources[0], true)');
    f.reply('model_status', modelStatus()); await open;
    expect(f.dialog.textContent).toContain('https://synthetic.invalid/v1/chat/completions');
    expect(f.dialog.textContent).toContain('test-model');
    expect(f.dialog.textContent).toContain('provider');
    const work = findAction(f.dialog, 'Allow this model').fire('click'); await tick();
    expect(f.requests.map(x => x.route)).toEqual(['source_model_consent']);
    expect(f.requests[0]!.payload).toMatchObject({ source_key: 'source-a', expected_revision: 'source-1', expected_model_revision: 'model-1', allow: true });
    expect(f.requests[0]!.payload.operation_id).toBeString();
    f.reply('source_model_consent', { source_key: 'source-a', revision: 'source-2', status: 'current' }); await tick();
    f.reply('status', status()); await tick(); f.reply('catalog', { sources: [] }); f.reply('sources', { sources: [] }); await work;
    expect(f.requests.some(x => x.route === 'capture' || x.route === 'run_pass')).toBe(false);
});

test('mismatched source consent never reads as permission for the current model', () => {
    const f = fixture(); f.evaluate(`state.model=${JSON.stringify(modelStatus())}; state.view='sources'; state.sources[0].model_consent='different_model'; render();`);
    expect(f.main.textContent).toContain('Permission is for a different model');
    expect(f.main.textContent).toContain('test-model');
    expect(findAction(f.main, 'Review model permission')).toBeTruthy();
    expect(findAction(f.main, 'Withdraw model permission')).toBeTruthy();
});

test('processing reports real run receipt counts and does not equate capture with memory writes', async () => {
    const f = fixture(); const work = f.evaluate<Promise<void>>('runPass()');
    expect(f.requests[0]!.route).toBe('run_pass'); expect(f.requests[0]!.payload).toEqual({});
    f.reply('run_pass', { operation_id: 'process' }); await tick();
    const operation = { id: 'process', kind: 'run_pass', state: 'succeeded', result: { run: { run_id: 'receipt-real', status: 'completed', canon_writes: 2, claims_extracted: 3, model_calls: 1, model_configured: true } } };
    f.reply('operation', operation); await tick();
    f.reply('status', status([operation])); await tick(); f.reply('catalog', { sources: [] }); f.reply('sources', { sources: [] }); await work;
    expect(f.main.textContent).toContain('2 memory writes'); expect(f.main.textContent).toContain('receipt-real');
    f.evaluate(`state.operation={kind:'capture',state:'succeeded',counts:{stored:9}}; render();`);
    expect(f.main.textContent).not.toContain('9 memory writes');
});

test('late model status and save cannot reopen private panels after disconnect', async () => {
    const f = fixture(); const work = f.evaluate<Promise<void>>('modelSettings()');
    f.evaluate('disconnect()'); f.reply('model_status', modelStatus()); await work;
    expect(f.dialog.open).toBe(false); expect(f.evaluate('state.model')).toBeNull();
    expect(f.main.textContent).not.toContain('test-model');
});

test('model off and key removal are explicit writes, and UTF-8 oversized keys never leave the form', async () => {
    for (const action of ['off', 'clear', 'keep', 'oversize']) {
        const f = fixture(); await openModel(f);
        if (action === 'off') { f.dialog.querySelector('#model-kind')!.value = 'none'; await f.dialog.querySelector('#model-kind')!.fire('change'); }
        if (action === 'clear') { f.dialog.querySelector('#model-clear-key')!.checked = true; await f.dialog.querySelector('#model-clear-key')!.fire('change'); }
        if (action === 'oversize') f.dialog.querySelector('#model-key')!.value = '界'.repeat(400);
        const save = f.dialog.querySelector('form')!.fire('submit', { preventDefault() {} }); await tick();
        if (action === 'oversize') { await save; expect(f.requests).toHaveLength(0); expect(f.dialog.querySelector('#model-key')!.value).toBe(''); expect(f.dialog.textContent).toContain('too long'); continue; }
        expect(f.requests[0]!.payload.credential).toEqual({ action: action === 'clear' ? 'clear' : 'keep' });
        if (action === 'off') expect(f.requests[0]!.payload.selection).toEqual({ kind: 'none' });
        f.reply('model_save', action === 'off' ? { ...modelStatus(), selection: { kind: 'none' } } : modelStatus()); await save;
    }
});

test('withdrawal is allowed with model off and retains separate source revision checks', async () => {
    const f = fixture(); f.evaluate(`state.sources[0].revision='source-1';`);
    const open = f.evaluate<Promise<void>>('modelConsent(state.sources[0], false)');
    f.reply('model_status', { ...modelStatus(), selection: { kind: 'none' } }); await open;
    const work = findAction(f.dialog, 'Withdraw permission').fire('click'); await tick();
    expect(f.requests[0]!.payload).toMatchObject({ expected_revision: 'source-1', expected_model_revision: 'model-1', allow: false });
    f.requests.shift()!.result.resolve({ status: 409, json: async () => ({ ok: false, error: { code: 'revision_conflict', message: 'UNTRUSTED_ERROR_CONTENT' } }) }); await work;
    expect(f.dialog.textContent).toContain('Something changed');
    expect(f.dialog.textContent).not.toContain('UNTRUSTED_ERROR_CONTENT');
    expect(findAction(f.dialog, 'Withdraw permission').disabled).toBe(false);
});

test('privacy invalidation fences a save already in flight and clears run receipt information', async () => {
    const f = fixture(); await openModel(f);
    f.dialog.querySelector('#model-key')!.value = 'SYNTHETIC_KEY';
    const work = f.dialog.querySelector('form')!.fire('submit', { preventDefault() {} }); await tick();
    f.evaluate(`state.operation={result:{run:{run_id:'PRIVATE_RUN'}}}; invalidatePrivateView();`);
    f.reply('model_save', modelStatus()); await work;
    expect(f.evaluate('state.model')).toBeNull(); expect(f.evaluate('state.operation')).toBeNull();
    expect(f.dialog.textContent).toBe(''); expect(f.main.textContent).toBe(''); expect(f.notice.textContent).toBe('');
});

test('old connection tests are hidden after configuration changes and returned identifiers are text', () => {
    const f = fixture();
    f.evaluate(`state.view='settings'; state.model=${JSON.stringify({ ...modelStatus('new'), selection: { ...modelStatus().selection, model: '<img src=x onerror=alert(1)>' }, last_test: { revision: 'old', outcome: 'succeeded', at: '2026-09-07T12:00:00Z', latency_ms: 1 } })}; render();`);
    expect(f.main.textContent).not.toContain('Connection test passed');
    expect(f.main.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(f.main.querySelector('img')).toBeNull();
});

test('failed synthetic test refreshes the saved test outcome without claiming connection success', async () => {
    const f = fixture(); f.evaluate(`state.model=${JSON.stringify(modelStatus())}; state.view='settings'; render();`);
    const work = findAction(f.main, 'Test connection').fire('click'); await tick();
    f.reply('model_test', { operation_id: 'test' }); await tick();
    f.reply('operation', { id: 'test', kind: 'model_test', state: 'failed', error: { code: 'model_unavailable' } }); await tick();
    f.reply('model_status', { ...modelStatus(), last_test: { revision: 'model-1', at: '2026-09-07T12:00:00Z', outcome: 'failed', latency_ms: 12, error_code: 'model_unavailable' } }); await work;
    expect(f.main.textContent).toContain('Connection test failed');
    expect(f.main.textContent).not.toContain('Connection test passed');
    expect(f.requests.some(x => x.route === 'source_model_consent')).toBe(false);
});

test('unreadable existing model settings do not expose a replacement form', async () => {
    const f = fixture(); const work = f.evaluate<Promise<void>>('modelSettings()');
    f.requests.shift()!.result.resolve({ status: 400, json: async () => ({ ok: false, error: { code: 'model_config_invalid' } }) }); await work;
    expect(f.dialog.querySelector('form')).toBeNull();
    expect(f.dialog.textContent).toContain('existing settings have not been replaced');
    expect(f.requests).toHaveLength(0);
});

const readGrant = { ceiling: 'public', types: null, subjects: null, since: null, until: null, tools: ['search', 'get_page'], rate_limit_per_minute: 60, relay_owner_corrections: false };
test('agent enrollment reviews all eight grant fields before submitting a read-only identity', async () => {
    const f = fixture(); f.evaluate('agentEnrollment()');
    f.dialog.querySelector('#agent-name')!.value = 'research-helper';
    await f.dialog.querySelector('form')!.fire('submit', { preventDefault() {} });
    expect(f.requests).toHaveLength(0);
    for (const label of ['Sensitivity ceiling', 'Record types', 'Subjects', 'From', 'Until', 'Tools', 'Requests per minute', 'Owner correction relay']) expect(f.dialog.textContent).toContain(label);
    expect(f.dialog.textContent).toContain('Off');
    const work = findAction(f.dialog, 'Create agent').fire('click'); await tick();
    expect(f.requests[0]!.route).toBe('agent_enroll');
    expect(f.requests[0]!.payload).toMatchObject({ name: 'research-helper', grant: readGrant });
    expect(f.requests[0]!.payload.operation_id).toBeString();
    f.reply('agent_enroll', { operation_id: 'enroll-agent' }); await tick();
    f.reply('operation', { id: 'enroll-agent', kind: 'agent_enroll', state: 'succeeded', result: { agent: { receipt: { name: 'research-helper', status: 'completed', authority: 'active', credential: 'ready', grant: readGrant }, mcp: { command: '/opt/kizuki-mcp', args: ['--vault', '/local/kizuki', '--token-ref', 'file:/local/private/agent.json'] } } } }); await tick();
    f.reply('agents', { agents: [] }); await work;
    expect(f.dialog.querySelector('textarea')!.value).toContain('--token-ref'); expect(f.dialog.querySelector('textarea')!.value).not.toContain('--owner');
    await findAction(f.dialog, 'Copy launch configuration').fire('click');
    expect(f.clipboardWrites).toEqual([f.dialog.querySelector('textarea')!.value]);
    expect(f.storageWrites).toHaveLength(0);
});

test('agent grant form submits explicit narrowed scopes, ceiling and read tools', async () => {
    const f = fixture(); f.evaluate('agentEnrollment()');
    f.dialog.querySelector('#agent-name')!.value = 'notes-helper';
    f.dialog.querySelector('#agent-ceiling')!.value = 'private';
    f.dialog.querySelector('#agent-types')!.value = 'person, fact';
    f.dialog.querySelector('#agent-subjects')!.value = 'person:ada';
    f.dialog.querySelector('#agent-tool-get_page')!.checked = false;
    f.dialog.querySelector('#agent-rate')!.value = '12';
    await f.dialog.querySelector('form')!.fire('submit', { preventDefault() {} });
    void findAction(f.dialog, 'Create agent').fire('click'); await tick();
    expect(f.requests[0]!.payload.grant).toEqual({ ...readGrant, ceiling: 'private', types: ['person', 'fact'], subjects: ['person:ada'], tools: ['search'], rate_limit_per_minute: 12 });
    expect(f.requests[0]!.payload).not.toHaveProperty('token_ref');
});

test('agent launch projection refuses owner or raw-token configurations', () => {
    const f = fixture();
    for (const args of [['--owner'], ['--token', 'kzk_SYNTHETIC'], ['--token-ref', 'env:OWNER_TOKEN'], ['--token-ref', 'file:/private/agent.json', '--owner=true']]) {
        const config = { command: '/opt/kizuki-mcp', args };
        expect(f.evaluate(`agentLaunchConfig(${JSON.stringify(config)})`)).toBeNull();
    }
    const config = { command: '/opt/kizuki-mcp', args: ['--vault', '/local/kizuki', '--token-ref', 'file:/private/agent.json'] };
    expect(f.evaluate<typeof config>(`agentLaunchConfig(${JSON.stringify(config)})`)).toEqual(config);
});

test('agent revocation uses only the selected identity name and shows the actual authority receipt', async () => {
    const f = fixture(); f.evaluate(`agentRevoke({name:'research-helper',grant:${JSON.stringify(readGrant)},revoked_at:null})`);
    const work = findAction(f.dialog, 'Revoke access').fire('click'); await tick();
    expect(f.requests[0]!.route).toBe('agent_revoke'); expect(f.requests[0]!.payload).toEqual({ name: 'research-helper' });
    f.reply('agent_revoke', { operation_id: 'revoke-agent' }); await tick();
    f.reply('operation', { id: 'revoke-agent', kind: 'agent_revoke', state: 'succeeded', result: { agent: { receipt: { name: 'research-helper', status: 'completed', authority: 'revoked', credential: 'unknown', grant: null }, mcp: null } } }); await tick();
    f.reply('agents', { agents: [] }); await work;
    expect(f.dialog.textContent).toContain('revoked'); expect(f.dialog.textContent).not.toContain('Copy launch configuration');
});

test('agent records and deferred enrollment results cannot return after privacy invalidation', async () => {
    const f = fixture(); const work = f.evaluate<Promise<void>>('loadAgents()');
    f.evaluate('invalidatePrivateView()'); f.reply('agents', { agents: [{ name: 'PRIVATE_AGENT' }] }); await work;
    expect(f.evaluate('state.agents')).toBeNull(); expect(f.main.textContent + f.dialog.textContent).not.toContain('PRIVATE_AGENT');
});

test('agent setup refuses invalid names and reversed time windows before enrollment', async () => {
    const f = fixture(); f.evaluate('agentEnrollment()');
    f.dialog.querySelector('#agent-name')!.value = 'Assistant Name';
    await f.dialog.querySelector('form')!.fire('submit', { preventDefault() {} });
    expect(f.dialog.textContent).toContain('lowercase letters'); expect(f.requests).toHaveLength(0);
    f.dialog.querySelector('#agent-name')!.value = 'assistant-name';
    f.dialog.querySelector('#agent-since')!.value = '2026-09-08T12:00';
    f.dialog.querySelector('#agent-until')!.value = '2026-09-07T12:00';
    await f.dialog.querySelector('form')!.fire('submit', { preventDefault() {} });
    expect(f.dialog.textContent).toContain('start time must be before'); expect(f.requests).toHaveLength(0);
});
