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
    focused = false;
    namespaceURI = 'http://www.w3.org/2000/svg';
    constructor(public tag = 'div') {}
    get tagName() { return this.tag.toUpperCase(); }
    set textContent(text: string) { this.ownText = text; this.children = []; }
    get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(''); }
    append(...nodes: Element[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    prepend(node: Element) { node.parent = this; this.children.unshift(node); }
    replaceChildren(...nodes: Element[]) { this.children = []; this.ownText = ''; this.append(...nodes); }
    replaceWith(node: Element) { if (this.parent) { const at = this.parent.children.indexOf(this); this.parent.children[at] = node; node.parent = this.parent; } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    setAttribute(key: string, value: string) { this.attributes[key] = value; if (key === 'class') this.className = value; }
    getAttribute(key: string) { return this.attributes[key] ?? null; }
    addEventListener(name: string, fn: (event: any) => unknown) { (this.listeners[name] ??= []).push(fn); }
    fire(name: string, event: unknown = {}) { return Promise.all((this.listeners[name] ?? []).map(fn => fn(event))); }
    contains(node: Element): boolean { return this === node || this.children.some(child => child.contains(node)); }
    querySelector(selector: string): Element | null { return this.children.find(child => selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : selector.startsWith('#') ? child.attributes.id === selector.slice(1) : child.tag === selector) ?? this.children.map(child => child.querySelector(selector)).find(Boolean) ?? null; }
    showModal() { this.open = true; }
    close() { this.open = false; queueMicrotask(() => { void this.fire('close'); }); }
    focus() { this.focused = true; }
    scrollIntoView() {}
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

test('Activity names the receipt action while preserving exact references in closed details', () => {
    for (const [action, title] of [['create', 'Memory page created'], ['edit', 'Memory page updated'], ['archive', 'Memory page removed'], ['unknown', 'Memory change'], ['toString', 'Memory change']] as const) {
        const f = fixture();
        const receipt = { id: 'receipt-synthetic', page: 'auto/captures/synthetic-page.md', action, at: '2026-09-07T00:00:00Z', reverted: false };
        f.evaluate(`state.view='activity'; state.receipts=[${JSON.stringify(receipt)}]; render();`);
        expect(f.main.querySelector('h3')!.textContent).toBe(title);
        const details = f.main.querySelector('details')!;
        expect(details.attributes.open).toBeUndefined();
        expect(details.textContent).toContain(receipt.page);
        expect(details.textContent).toContain(receipt.id);
        expect(f.main.querySelector('h3')!.textContent).not.toContain(receipt.page);
        expect(f.storageWrites).toHaveLength(0);
    }
});

test('Activity keeps the exact undo target and shows undone receipts without another undo action', async () => {
    const f = fixture();
    const receipt = { id: 'receipt-exact', page: 'auto/captures/exact-page.md', action: 'edit', at: '2026-09-07T00:00:00Z', reverted: false };
    f.evaluate(`state.view='activity'; state.receipts=[${JSON.stringify(receipt)}]; render();`);
    await f.main.querySelector('button')!.fire('click');
    expect(f.dialog.textContent).toContain(receipt.page);
    const submit = f.dialog.querySelector('.form-actions')!.children.find(node => node.textContent === 'Undo change')!;
    const request = submit.fire('click');
    expect(f.requests.find(row => row.route === 'undo')!.payload).toEqual({ receipt_id: receipt.id, cascade: false });
    const pending = f.requests.splice(f.requests.findIndex(row => row.route === 'undo'), 1)[0]!;
    pending.result.resolve({ status: 400, json: async () => ({ ok: false, error: { code: 'invalid_request' } }) });
    await request;
    f.evaluate(`state.receipts=[${JSON.stringify({ ...receipt, reverted: true })}]; render();`);
    expect(f.main.querySelector('h3')!.textContent).toBe('Memory page updated');
    expect(f.main.textContent).toContain('Undone');
    expect(f.main.querySelector('button')).toBeNull();
});

test('pending recovery in the shipped client shows its result and never calls the undo success callback', async () => {
    const f = fixture();
    f.evaluate('globalThis.syntheticCompletions=0');
    const work = f.evaluate<Promise<void>>(`launchOperation('undo',{receipt_id:'synthetic-receipt'},'Undoing this change',async()=>{syntheticCompletions++;})`);
    f.reply('undo', { operation_id: 'pending-undo' }); await tick();
    f.reply('operation', { id: 'pending-undo', kind: 'undo', state: 'failed', stage: 'stopped', counts: null,
        result: { message: 'The memory change is undone. Retrieval updates remain pending; run kizuki recover --json.', recovery_pending: [{ receipt_id: 'synthetic-revert', phase: 'projection' }] },
        error: { code: 'recovery_pending', retryable: false } });
    await work; await tick();
    expect(f.evaluate<number>('syntheticCompletions')).toBe(0);
    expect(f.dialog.textContent).toContain('Retrieval updates remain pending');
    expect(f.dialog.textContent).toContain('kizuki recover --json');
    expect(f.evaluate<string>('state.operation.state')).toBe('failed');
});

test('a pending correction never renders zero pages as proof that no bytes moved', () => {
    const f = fixture();
    f.evaluate(`state.operation={id:'pending-correct',kind:'correct',state:'failed',error:{code:'recovery_pending',retryable:false},result:{message:'The statement is recorded. Canon completion is unconfirmed; recovery remains pending.',rewritten_pages:0,recovery_pending:[{receipt_id:'synthetic-receipt',phase:'write'}]}}; render();`);
    expect(f.main.textContent).toContain('Canon completion is unconfirmed');
    expect(f.main.textContent).not.toContain('0 memory pages rewritten');
});

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

test('first-run setup is a labeled form so Enter creates the workspace', async () => {
    const f = fixture();
    f.evaluate(`state.status={vault:{ready:false},setup_location:'/tmp/kizuki-empty',setup_no_service:false}; render();`);
    const path = f.main.querySelector('#setup-path')!;
    expect(f.main.querySelector('form')!.className).toBe('setup-form');
    expect(path.attributes['aria-describedby']).toBe('setup-path-help');
    expect(f.main.querySelector('#setup-path-help')!.textContent).toContain('new empty folder');
    expect(findLabelFor(f.main, 'setup-path')?.attributes.for).toBe('setup-path');
    path.value = '/tmp/kizuki-empty';
    f.main.querySelector('#setup-no-service')!.checked = true;
    const work = f.main.querySelector('form')!.fire('submit', { preventDefault() {} });
    await tick();
    expect(f.requests[0]!.route).toBe('initialize');
    expect(f.requests[0]!.payload).toEqual({ path: '/tmp/kizuki-empty', no_service: true });
    f.reply('initialize', { operation_id: 'init' }); await tick();
    f.reply('operation', { id: 'init', kind: 'initialize', state: 'failed', error: { code: 'unavailable' } });
    await work;
});

test('failed workspace creation returns to setup options instead of a modal dead end', async () => {
    const f = fixture();
    f.evaluate(`state.status={vault:{ready:false},setup_location:'/tmp/kizuki-empty',visibility_epoch:'uninitialized',operations:[]}; render();`);
    f.main.querySelector('#setup-path')!.value = '/tmp/existing-notes';
    const work = f.evaluate<Promise<void>>('initialize()');
    f.reply('initialize', { operation_id: 'init' }); await tick();
    f.reply('operation', { id: 'init', kind: 'initialize', state: 'failed', error: { code: 'unavailable' } });
    await work; await tick();
    expect(f.dialog.open).toBe(false);
    expect(f.main.querySelector('details')!.open).toBe(true);
    expect(f.main.textContent).toContain('new empty folder');
    expect(f.main.querySelector('#setup-error')!.textContent).toContain('never adopted automatically');
    expect(f.main.querySelector('#setup-path')!.value).toBe('/tmp/existing-notes');
    expect(f.main.querySelector('#setup-path')!.focused).toBe(true);
    expect(f.main.querySelector('#setup-path')!.attributes['aria-invalid']).toBe('true');
    expect(f.main.textContent).not.toContain('Completed');
});

test('successful setup opens sources without a stale completed banner and focuses Connect', async () => {
    const f = fixture();
    f.evaluate(`state.status={vault:{ready:false},visibility_epoch:'uninitialized',operations:[]}; state.sources=[]; render();`);
    const work = f.evaluate<Promise<void>>('initialize()');
    f.reply('initialize', { operation_id: 'init' }); await tick();
    const job = { id: 'init', kind: 'initialize', state: 'succeeded', result: { message: 'Workspace created' } };
    f.reply('operation', job); await tick();
    f.reply('status', { vault: { ready: true }, visibility_epoch: '1', operations: [job] }); await tick();
    f.reply('catalog', { sources: [{ id: 'markdown', title: 'Local notes', available: true, detail: 'Synthetic', fields: [], required_fields: ['text'] }] });
    f.reply('sources', { sources: [] }); await work; await tick();
    expect(f.evaluate<string>('state.view')).toBe('sources');
    expect(f.main.textContent).toContain('Choose your first source');
    expect(f.main.textContent).not.toContain('Completed');
    expect(findAction(f.main, 'Connect').focused).toBe(true);
});

test('memory keeps Markdown onboarding when a source still needs permission or import', () => {
    const f = fixture();
    f.evaluate(`state.view='memory'; state.hits=null; state.sources[0].consent='required'; state.sources[0].last_run=null; render();`);
    expect(f.main.textContent).toContain('Permission comes before import');
    expect(findAction(f.main, 'Review permission')).toBeTruthy();
    f.evaluate(`state.sources[0].consent='active'; state.sources[0].last_run=null; state.sources[0].stored=0; render();`);
    expect(f.main.textContent).toContain('Import this source to search it');
    expect(findAction(f.main, 'Import history')).toBeTruthy();
});

test('source enrollment focuses the labeled folder field instead of the close control', () => {
    const f = fixture();
    f.evaluate(`enrollment({id:'markdown',title:'Local notes',detail:'Synthetic',available:true,fields:[],required_fields:['text']})`);
    const path = f.dialog.querySelector('#source-path')!;
    expect(path.focused).toBe(true);
    expect(path.attributes['aria-describedby']).toBe('source-path-help');
    expect(f.dialog.querySelector('#source-path-help')!.textContent).toContain('outside your Kizuki workspace');
    expect(f.dialog.querySelector('.icon-button')!.focused).toBe(false);
});

test('source permission can be granted from the keyboard submit path', async () => {
    const f = fixture();
    f.evaluate('consent(state.sources[0])');
    expect(f.dialog.querySelector('form')).toBeTruthy();
    expect(findAction(f.dialog, 'Allow and import').focused).toBe(true);
    const work = f.dialog.querySelector('form')!.fire('submit', { preventDefault() {} });
    await tick();
    expect(f.requests[0]!.route).toBe('consent');
    expect(f.requests[0]!.payload.source_key).toBe('source-a');
    f.reply('consent', { source_key: 'source-a', revision: 1, status: 'active' }); await tick();
    f.reply('status', status()); await tick();
    f.reply('catalog', { sources: [] });
    f.reply('sources', { sources: [{ source_key: 'source-a', connector_id: 'kizuki.markdown-folder', display_name: 'markdown-folder', consent: 'active', required_fields: ['text'], stored: 0, errors: 0 }] });
    await tick();
    expect(f.requests.some(request => request.route === 'capture')).toBe(true);
    f.reply('capture', { operation_id: 'cap' }); await tick();
    f.reply('operation', { id: 'cap', kind: 'capture', state: 'succeeded', counts: { stored: 1, duplicates: 0, errors: 0 } }); await tick();
    f.reply('status', status()); await tick();
    f.reply('catalog', { sources: [] });
    f.reply('sources', { sources: [] });
    await work;
});

test('failed first capture offers a retry of the same source', async () => {
    const f = fixture();
    const work = f.evaluate<Promise<void>>('capture(state.sources[0])');
    f.reply('capture', { operation_id: 'cap' }); await tick();
    f.reply('operation', { id: 'cap', kind: 'capture', state: 'failed', error: { code: 'unavailable' } });
    await work; await tick();
    expect(f.dialog.textContent).toContain('Import did not finish');
    expect(f.dialog.textContent).toContain('Try again');
    const retry = findAction(f.dialog, 'Try again').fire('click'); await tick();
    expect(f.requests[0]!.route).toBe('capture');
    expect(f.requests[0]!.payload).toEqual({ source_key: 'source-a', mode: 'backfill' });
    f.reply('capture', { operation_id: 'cap2' }); await tick();
    f.reply('operation', { id: 'cap2', kind: 'capture', state: 'succeeded', counts: { stored: 1, duplicates: 0, errors: 0 } }); await tick();
    f.reply('status', status()); await tick();
    f.reply('catalog', { sources: [] });
    f.reply('sources', { sources: [] });
    await retry;
});

test('failed folder enrollment restores the labeled path instead of leaving a close-only panel', async () => {
    const f = fixture();
    f.evaluate(`state.catalog=[{id:'markdown',title:'Local notes',detail:'Synthetic',available:true,fields:[],required_fields:['text']}]; enrollment(state.catalog[0]); dialog.querySelector('#source-path').value='/tmp/notes';`);
    const work = f.dialog.querySelector('form')!.fire('submit', { preventDefault() {} });
    f.reply('enroll', { operation_id: 'enroll-1' }); await tick();
    f.reply('operation', { id: 'enroll-1', kind: 'enroll', state: 'failed', error: { code: 'unavailable' } });
    await work; await tick();
    expect(f.dialog.querySelector('#source-path')!.value).toBe('/tmp/notes');
    expect(f.dialog.querySelector('#source-path')!.focused).toBe(true);
    expect(f.dialog.querySelector('.form-error')!.textContent).toContain('outside your Kizuki workspace');
    expect(f.dialog.textContent).toContain('Connect folder');
});

test('a queued native close and late success leave a newly opened dialog intact', async () => {
    const f = fixture();
    f.evaluate(`state.catalog=[{id:'markdown',title:'Local notes',detail:'Synthetic',available:true,fields:[],required_fields:['text']}]; enrollment(state.catalog[0]); dialog.querySelector('#source-path').value='/tmp/old';`);
    const work = f.dialog.querySelector('form')!.fire('submit', { preventDefault() {} });
    f.reply('enroll', { operation_id: 'enroll-newer' }); await tick();
    f.evaluate(`closeDialog(); enrollment(state.catalog[0]); dialog.querySelector('#source-path').value='/tmp/new';`);
    await tick();
    f.reply('operation', { id: 'enroll-newer', kind: 'enroll', state: 'succeeded', result: { source_key: 'source-a' } }); await tick();
    f.reply('status', status()); await tick(); f.reply('catalog', { sources: [] }); f.reply('sources', { sources: [] });
    await work; await tick();
    expect(f.dialog.open).toBe(true);
    expect(f.dialog.querySelector('#source-path')!.value).toBe('/tmp/new');
    expect(f.dialog.querySelector('#source-path')!.focused).toBe(true);
    expect(f.dialog.textContent).toContain('Connect folder');
});

test('a closed enrollment panel is not reopened by its later failure', async () => {
    const f = fixture();
    f.evaluate(`state.catalog=[{id:'markdown',title:'Local notes',detail:'Synthetic',available:true,fields:[],required_fields:['text']}]; enrollment(state.catalog[0]); dialog.querySelector('#source-path').value='/tmp/notes';`);
    const work = f.dialog.querySelector('form')!.fire('submit', { preventDefault() {} });
    f.reply('enroll', { operation_id: 'enroll-late' }); await tick();
    f.evaluate('closeDialog()');
    f.reply('operation', { id: 'enroll-late', kind: 'enroll', state: 'failed', error: { code: 'unavailable' } });
    await work; await tick();
    expect(f.dialog.open).toBe(false);
    expect(f.dialog.textContent).not.toContain('Connect folder');
    expect(f.notice.textContent).toContain('This folder could not be connected');
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

function findLabelFor(node: Element, target: string): Element | undefined {
    return node.tag === 'label' && node.attributes.for === target
        ? node
        : node.children.map(child => findLabelFor(child, target)).find(Boolean);
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

const belief = { claim_id: 'claim-a', subject: 'person:ada', predicate: 'works_at', object: 'Old company', body: 'Ada works at Old company.', authority: 'owner_authored', sensitivity: 'private' };
async function openCorrection(f: ReturnType<typeof fixture>, claims = [belief], truncated = false) {
    const work = f.evaluate<Promise<void>>(`correction({id:'page-a',scope:'canon',title:'People'})`);
    expect(f.requests[0]!.payload).toEqual({ page_id: 'page-a' });
    f.reply('correction_targets', { claims, truncated }); await work;
}

test('correction action belongs only to canon search results and reads exact admitted page targets', async () => {
    const f = fixture(); f.evaluate(`state.hits=[{id:'page-a',scope:'canon',title:'People',text:'Memory page'},{id:'event-a',scope:'ledger',title:'Source',text:'Source quote'}]; render();`);
    expect(findAction(f.main, 'Correct memory')).toBeTruthy();
    await f.evaluate(`correction({id:'event-a',scope:'ledger',title:'Source'})`); expect(f.requests).toHaveLength(0);
    await openCorrection(f, [belief], true);
    expect(f.dialog.textContent).toContain('This list is limited'); expect(f.dialog.textContent).toContain(belief.body);
});

test('denial preview omits object, requires own statement and applies the same exact belief', async () => {
    const f = fixture(); await openCorrection(f);
    await f.dialog.querySelector('form')!.fire('submit', { preventDefault() {} });
    expect(f.requests).toHaveLength(0); expect(f.dialog.textContent).toContain('Explain the correction');
    f.dialog.querySelector('#correction-statement')!.value = 'This recorded belief is wrong.';
    const preview = f.dialog.querySelector('form')!.fire('submit', { preventDefault() {} }); await tick();
    const payload = { claim_id: 'claim-a', statement: 'This recorded belief is wrong.' };
    expect(f.requests[0]!.route).toBe('correction_preview'); expect(f.requests[0]!.payload).toEqual(payload);
    f.reply('correction_preview', { answer: 'Would deny this reading.', affected_pages: 2 }); await preview;
    expect(f.dialog.textContent).toContain('2 memory pages currently affected');
    const panel = f.dialog.querySelector('.correction-preview')!;
    expect(panel.textContent).toContain('Deny the selected belief without adding a replacement.');
    expect(panel.textContent).toContain(payload.statement);
    expect(panel.querySelector('details')!.textContent).toContain('Would deny this reading.');
    expect(panel.querySelector('details')!.open).toBe(false);
    void findAction(f.dialog, 'Apply correction').fire('click'); await tick();
    expect(f.requests[0]!.route).toBe('correct'); expect(f.requests[0]!.payload).toEqual(payload);
    expect(f.storageWrites).toHaveLength(0);
});

test('correction keeps exact beliefs and submitted replacement visible while technical identifiers remain expandable', async () => {
    const f = fixture();
    const exact = { ...belief, subject: 'markdown-folder:' + 'f'.repeat(64), predicate: 'employment.role', object: '<Old value>', body: 'An unchanged recorded belief.' };
    await openCorrection(f, [exact]);
    const details = f.dialog.querySelector('.belief-details')!;
    const visibleBelief = details.children.filter(child => child.tag !== 'details').map(child => child.textContent).join('');
    expect(visibleBelief).toContain(exact.body); expect(visibleBelief).toContain(exact.object);
    expect(visibleBelief).not.toContain(exact.subject); expect(visibleBelief).not.toContain(exact.predicate);
    const references = details.querySelector('details')!;
    for (const value of [exact.subject, exact.predicate, exact.claim_id, exact.authority, exact.sensitivity]) expect(references.textContent).toContain(value);
    expect(references.open).toBe(false);
    const mode = f.dialog.querySelector('#correction-mode')!; mode.value = 'replace'; await mode.fire('change');
    const replacement = '  <New value>  ', statement = 'First line.\nSecond line.';
    f.dialog.querySelector('#correction-value')!.value = replacement;
    f.dialog.querySelector('#correction-statement')!.value = statement;
    const work = f.dialog.querySelector('form')!.fire('submit', { preventDefault() {} }); await tick();
    const answer = `Nothing was written. This would retire 1 claim(s) about ${exact.subject}.`;
    f.reply('correction_preview', { answer, affected_pages: 1 }); await work;
    const panel = f.dialog.querySelector('.correction-preview')!;
    const visiblePreview = panel.children.filter(child => child.tag !== 'details').map(child => child.textContent).join('');
    expect(visiblePreview).toContain('Replace the selected belief’s value with:');
    expect(visiblePreview).toContain(replacement); expect(visiblePreview).toContain(statement);
    expect(visiblePreview).toContain('1 memory page currently affected.'); expect(visiblePreview).not.toContain(exact.subject);
    expect(panel.querySelector('details')!.textContent).toContain(answer); expect(panel.querySelector('details')!.open).toBe(false);
    expect(f.dialog.querySelector('img')).toBeNull();
    void findAction(f.dialog, 'Apply correction').fire('click'); await tick();
    expect(f.requests[0]!.payload).toEqual({ claim_id: exact.claim_id, statement, object: replacement });
    expect(f.storageWrites).toHaveLength(0);
});

test('replacement value is explicit and field changes invalidate preview including pending responses', async () => {
    const f = fixture(); await openCorrection(f);
    const mode = f.dialog.querySelector('#correction-mode')!; mode.value = 'replace'; await mode.fire('change');
    f.dialog.querySelector('#correction-statement')!.value = 'Ada moved to New company.';
    const value = f.dialog.querySelector('#correction-value')!; value.value = 'New company';
    const first = f.dialog.querySelector('form')!.fire('submit', { preventDefault() {} }); await tick();
    expect(f.requests[0]!.payload).toEqual({ claim_id: 'claim-a', statement: 'Ada moved to New company.', object: 'New company' });
    value.value = 'Another company'; await value.fire('input');
    f.reply('correction_preview', { answer: 'STALE_PREVIEW', affected_pages: 2 }); await first;
    expect(f.dialog.textContent).not.toContain('STALE_PREVIEW'); expect(findAction(f.dialog, 'Apply correction').disabled).toBe(true);
    const fresh = f.dialog.querySelector('form')!.fire('submit', { preventDefault() {} }); await tick();
    f.reply('correction_preview', { answer: 'Current preview', affected_pages: null }); await fresh;
    expect(f.dialog.textContent).toContain('Current affected-page count unavailable');
    expect(f.dialog.textContent).not.toContain('0 memory pages');
    mode.value = 'deny'; await mode.fire('change'); expect(value.value).toBe(''); expect(findAction(f.dialog, 'Apply correction').disabled).toBe(true);
});

test('correction drafts and targets clear on closure, navigation, disconnect and privacy invalidation', async () => {
    for (const action of ['closeDialog()', `dialog.fire('cancel')`, `navigate('sources')`, 'disconnect()', 'invalidatePrivateView()', `window.fire('pagehide')`]) {
        const f = fixture(); await openCorrection(f);
        const statement = f.dialog.querySelector('#correction-statement')!; statement.value = 'PRIVATE_STATEMENT';
        const value = f.dialog.querySelector('#correction-value')!; value.value = 'PRIVATE_VALUE';
        const work = f.dialog.querySelector('form')!.fire('submit', { preventDefault() {} }); await tick();
        await f.evaluate(action);
        f.reply('correction_preview', { answer: 'PRIVATE_LATE_PREVIEW', affected_pages: 1 }); await work;
        expect(statement.value).toBe(''); expect(value.value).toBe('');
        expect(f.dialog.textContent).not.toContain(belief.body); expect(f.dialog.textContent).not.toContain('PRIVATE_LATE_PREVIEW');
        expect(f.storageWrites).toHaveLength(0);
    }
});

test('changing the selected belief or changing fields without an input event cannot apply an old preview', async () => {
    const f = fixture(); await openCorrection(f, [belief, { ...belief, claim_id: 'claim-b', object: 'Different company' }]);
    const statement = f.dialog.querySelector('#correction-statement')!; statement.value = 'This is wrong.';
    const preview = f.dialog.querySelector('form')!.fire('submit', { preventDefault() {} }); await tick();
    f.reply('correction_preview', { answer: 'Would deny claim-a.', affected_pages: 1 }); await preview;
    statement.value = 'Changed silently.';
    await findAction(f.dialog, 'Apply correction').fire('click'); expect(f.requests).toHaveLength(0);
    const choice = f.dialog.querySelector('#correction-claim')!; choice.value = 'claim-b'; await choice.fire('change');
    expect(f.dialog.textContent).toContain('Different company'); expect(findAction(f.dialog, 'Apply correction').disabled).toBe(true);
});

test('correction result reports actual message, rewritten count and receipt as escaped text', () => {
    const f = fixture(); f.evaluate(`state.operation={id:'correct-1',kind:'correct',state:'succeeded',result:{message:'Recorded <img src=x> correction.',rewritten_pages:2,receipt_id:'receipt-actual'}}; render();`);
    expect(f.main.textContent).toContain('Recorded <img src=x> correction.'); expect(f.main.querySelector('img')).toBeNull();
    expect(f.main.textContent).toContain('2 memory pages rewritten'); expect(f.main.textContent).toContain('receipt-actual');
});

test('closed correction target requests cannot expose late beliefs and empty target sets cannot apply', async () => {
    const f = fixture(); const work = f.evaluate<Promise<void>>(`correction({id:'page-a',scope:'canon'})`);
    f.evaluate('closeDialog()'); f.reply('correction_targets', { claims: [belief], truncated: false }); await work;
    expect(f.dialog.textContent).not.toContain(belief.body); expect(f.dialog.open).toBe(false);
    await openCorrection(f, []); expect(f.dialog.textContent).toContain('No correctable beliefs'); expect(f.dialog.querySelector('form')).toBeNull();
});

test('failed correction preview never enables application or displays provider error bodies', async () => {
    const f = fixture(); await openCorrection(f);
    f.dialog.querySelector('#correction-statement')!.value = 'This is wrong.';
    const work = f.dialog.querySelector('form')!.fire('submit', { preventDefault() {} }); await tick();
    f.requests.shift()!.result.resolve({ status: 403, json: async () => ({ ok: false, error: { code: 'source_capture_denied', message: 'PRIVATE_ERROR_BODY' } }) }); await work;
    expect(findAction(f.dialog, 'Apply correction').disabled).toBe(true); expect(f.dialog.textContent).not.toContain('PRIVATE_ERROR_BODY');
    await findAction(f.dialog, 'Apply correction').fire('click'); expect(f.requests).toHaveLength(0);
});

test('applied correction survives the changed privacy epoch only as its current operation receipt in Activity', async () => {
    const f = fixture(); await openCorrection(f);
    f.dialog.querySelector('#correction-statement')!.value = 'This is wrong.';
    const preview = f.dialog.querySelector('form')!.fire('submit', { preventDefault() {} }); await tick();
    f.reply('correction_preview', { answer: 'Would deny.', affected_pages: 1 }); await preview;
    const work = findAction(f.dialog, 'Apply correction').fire('click'); await tick();
    f.reply('correct', { operation_id: 'correct-epoch' }); await tick();
    const operation = { id: 'correct-epoch', kind: 'correct', state: 'succeeded', result: { message: 'Recorded correction.', receipt_id: 'receipt-current', rewritten_pages: 1 } };
    f.reply('operation', operation); await tick();
    f.reply('status', status([operation], '2')); await tick(); f.reply('catalog', { sources: [] }); f.reply('sources', { sources: [] }); await tick();
    f.reply('activity', { receipts: [] }); await work; await tick();
    expect(f.evaluate<string>('state.view')).toBe('activity'); expect(f.main.textContent).toContain('receipt-current');
    expect(f.dialog.textContent).toBe(''); expect(f.evaluate('state.hits')).toBeNull();
});

// The positive client oracle starts at real claim admission/canonical writes,
// crosses the authenticated loopback HTTP boundary, then executes shipped JS.
import { join } from 'node:path';
import { createHelpers } from './helpers';
import { startApp } from '../src/commands/app';
import type { CliIo } from '../src/commands';
import { hardenLedgerFile } from '@kizuki/core';
import { rebuildDerived } from '@kizuki/core/internal';
import { LABEL, SUBJECT, labelEvent, writeIdentity } from '../../core/test/serving/subject-label-fixture';
import { openLedger } from '../../core/src/ledger/db';
import { recordedPage } from '../../core/test/helpers/recorded-page';
import type { AppHit } from '../src/app/protocol';

test('real written identity crosses authenticated HTTP into readable App title, explicit subject chips and evidence', async () => {
    const helpers = createHelpers(), setup = helpers.tempVault();
    const path = join(setup.vault, '.kizuki', 'kizuki.db'), db = openLedger(path);
    const io = { db, vault_path: setup.vault };
    const first = await writeIdentity(io, { eventId: labelEvent(db, SUBJECT, 'public', 'Orchard names Ada Example.'), body: '> Orchard names Ada Example.', taint: 'quoted' }), handle = await writeIdentity(io, { predicate: 'identity.handle_on', object: '@ada-exact' });
    await writeIdentity(io, { subject: `person:${'b'.repeat(64)}`, object: 'Grace Example', frontmatter: { type: 'person', title: 'My trusted human title', subjects: [`person:${'b'.repeat(64)}`] } });
    await recordedPage(db, setup.vault, 'facts/clean-base.md', { id: 'fact:clean-base', title: 'A clean base page', type: 'fact', status: 'active', sensitivity: 'public', taint: 'clean', subjects: [SUBJECT] }, 'Orchard base prose.');
    expect(readFileSync(join(setup.vault, 'facts/clean-base.md'), 'utf8')).toContain('taint: "clean"');
    rebuildDerived(db, setup.vault); hardenLedgerFile(path); db.close();
    const original = readFileSync(join(setup.vault, first.receipt!.page_path));
    let launched = ''; const output: string[] = [];
    const cliIo: CliIo = { env: setup.env, vaultOverride: setup.vault, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, out: value => output.push(value), err: value => output.push(value), prompt: async () => { throw Error('no prompt'); } };
    const app = await startApp(cliIo, { noService: true }, async url => { launched = url; });
    try {
        const token = new URL(launched).hash.slice('#token='.length);
        const response = await fetch(app.url + '/app/v1/query', { method: 'POST', headers: { origin: app.url, authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'orchard' }) });
        expect(response.status).toBe(200);
        const body = await response.json() as { ok: boolean; data: { hits: AppHit[]; degraded: string[] } };
        expect(body.ok).toBe(true);
        const canonical = body.data.hits.find(hit => hit.scope === 'canon' && hit.title === 'a'.repeat(64) && hit.subject_labels?.some(label => label.subject === SUBJECT))!;
        const quoted = body.data.hits.find(hit => hit.scope === 'ledger' && hit.id === first.event)!;
        expect(body.data.hits.find(hit => hit.id === 'fact:clean-base')?.taint).toBe('quoted');
        expect(canonical.title).toBe('a'.repeat(64));
        expect(canonical.subject_labels?.[0]?.display_name).toBe(LABEL);
        expect(canonical.citations).toEqual(expect.arrayContaining([first.event, handle.event]));
        expect(quoted.subject_labels?.[0]?.display_name).toBe(LABEL);
        expect(quoted.citations).toContain(handle.event);
        const f = fixture(), request = f.evaluate<Promise<void>>(`search('orchard')`);
        f.reply('query', body.data); await request;
        const articles = f.main.querySelector('.results') ?? f.main;
        const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
        expect(all(articles).filter(node => node.tag === 'h3').map(node => node.textContent)).toContain(LABEL);
        expect(all(articles).filter(node => node.tag === 'h3').map(node => node.textContent)).toContain('My trusted human title');
        expect(all(articles).filter(node => node.attributes['aria-label'] === 'Recorded subject labels').some(node => node.textContent.includes('@ada-exact'))).toBe(true);
        expect(f.main.textContent).toContain('Includes quoted evidence');
        expect(f.main.textContent).not.toContain('UNTRUSTED_CAPTURE_NAME');
        expect(f.main.textContent).not.toContain('UNTRUSTED_METADATA_NAME');
        expect(f.storageWrites.join('')).not.toContain(LABEL);
        expect(output.join('')).not.toContain(LABEL);
        expect(readFileSync(join(setup.vault, first.receipt!.page_path))).toEqual(original);
        f.evaluate('invalidatePrivateView();render()');
        expect(f.main.textContent).not.toContain(LABEL); expect(f.main.textContent).not.toContain('@ada-exact');
        expect(f.evaluate('state.hits')).toBeNull();
    } finally { await app.close(); helpers.cleanup(); }
}, 30_000);

test('identity chips render hostile text literally and never assign a multi-subject result to the first subject', () => {
    const f = fixture(), hostile = '<img src=x onerror=globalThis.identityExecuted=true>';
    const label = { subject: 'person:one', display_name: hostile, handles: ['@one'], evidence: [] };
    const hit = { id: 'page', scope: 'canon', title: 'a'.repeat(64), text: 'Synthetic source body.', sensitivity: 'private', citations: [], subject_labels: [label] };
    f.evaluate(`state.hits=${JSON.stringify([hit])};render()`);
    expect(f.main.querySelector('h3')?.textContent).toBe(hostile);
    expect(f.main.querySelector('img')).toBeNull();
    expect(f.evaluate('globalThis.identityExecuted')).toBeUndefined();
    hit.subject_labels.push({ subject: 'person:two', display_name: 'Second Person', handles: [], evidence: [] });
    f.evaluate(`state.hits=${JSON.stringify([hit])};render()`);
    expect(f.main.querySelector('h3')?.textContent).toBe('Memory page');
    expect(f.main.textContent).toContain(hostile); expect(f.main.textContent).toContain('Second Person');
});

test('privacy invalidation discards held HTTP labels and cannot restore their names or handles', async () => {
    const f = fixture(), work = f.evaluate<Promise<void>>(`search('orchard')`);
    f.evaluate('invalidatePrivateView();render()');
    f.reply('query', { hits: [{ id: 'late', scope: 'canon', title: 'a'.repeat(64), text: 'held', sensitivity: 'private', citations: [], subject_labels: [{ subject: SUBJECT, display_name: 'REVOKED_IDENTITY_NAME', handles: ['@revoked-identity'], evidence: [] }] }], degraded: [] });
    await work;
    expect(f.evaluate('state.hits')).toBeNull();
    expect(f.main.textContent).not.toContain('REVOKED_IDENTITY_NAME'); expect(f.main.textContent).not.toContain('@revoked-identity');
});
