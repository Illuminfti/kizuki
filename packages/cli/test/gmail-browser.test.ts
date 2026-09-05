import { expect, spyOn, test } from 'bun:test';
import { openGmailBrowser } from '../src/gmail';
test('Gmail browser refuses foreign origins, credentials, paths and oversized URLs before spawn', async () => {
    let calls = 0;
    const hook = spyOn(Bun, 'spawn').mockImplementation((() => { calls++; throw Error('unexpected'); }) as typeof Bun.spawn);
    try {
        for (const url of ['https://example.test/o/oauth2/v2/auth', 'https://accounts.google.com.evil.test/o/oauth2/v2/auth', 'https://accounts.google.com/other', 'https://user:secret@accounts.google.com/o/oauth2/v2/auth', 'http://accounts.google.com/o/oauth2/v2/auth', 'https://accounts.google.com/o/oauth2/v2/auth#secret', 'https://accounts.google.com/o/oauth2/v2/auth?x=' + 'x'.repeat(8192)])
            await expect(openGmailBrowser(url)).rejects.toThrow('system browser');
        expect(calls).toBe(0);
    }
    finally {
        hook.mockRestore();
    }
});
test('native browser composition uses fixed shell-free argv and sanitized subprocess environment', async () => {
    let args: any[] = [];
    const hook = spyOn(Bun, 'spawn').mockImplementation(((...input: any[]) => { args = input; return { exitCode: 0, exited: Promise.resolve(0) }; }) as typeof Bun.spawn);
    try {
        const url = 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic';
        await openGmailBrowser(url);
        expect(args[0]).toEqual([process.platform === 'darwin' ? '/usr/bin/open' : '/usr/bin/xdg-open', url]);
        expect(args[1].stdout).toBe('ignore');
        expect(args[1].stderr).toBe('ignore');
        expect(args[1].stdin).toBe('ignore');
        expect(Object.keys(args[1].env).every(key => ['PATH', 'HOME', 'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CURRENT_DESKTOP'].includes(key))).toBe(true);
    }
    finally {
        hook.mockRestore();
    }
});
test('hung browser launcher is bounded and terminated without exposing URL or child errors', async () => {
    let killed: string | undefined, settle!: (code: number) => void;
    const exited = new Promise<number>(resolve => { settle = resolve; });
    const child = { exitCode: null as number | null, exited, kill: (signal: string) => { killed = signal; child.exitCode = 137; settle(137); } };
    const hook = spyOn(Bun, 'spawn').mockImplementation((() => child) as unknown as typeof Bun.spawn);
    try {
        await expect(openGmailBrowser('https://accounts.google.com/o/oauth2/v2/auth?state=PRIVATE_SENTINEL')).rejects.toThrow('Gmail system browser could not be opened');
        expect(killed).toBe('SIGKILL');
    }
    finally {
        hook.mockRestore();
    }
}, 8000);
