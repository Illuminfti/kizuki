import { spawn } from 'node:child_process';
import { withDeadline } from '@kizuki/core';
/** Trusted launch URL only; it contains the ephemeral capability and must never be logged. */
export async function openAppBrowser(raw: string): Promise<void> {
    const url = new URL(raw);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.username || url.password || !/^#token=[A-Za-z0-9_-]{43}$/.test(url.hash))
        throw Error('app_browser_unavailable');
    const executable = process.platform === 'linux' ? '/usr/bin/xdg-open' : process.platform === 'darwin' ? '/usr/bin/open' : null;
    if (!executable)
        throw Error('app_browser_unavailable');
    const env: Record<string, string> = {};
    for (const name of ['HOME', 'USER', 'LOGNAME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY', 'PATH']) {
        const value = process.env[name];
        if (value !== undefined)
            env[name] = value;
    }
    const child = spawn(executable, [url.toString()], { stdio: 'ignore', env, shell: false });
    const exited = new Promise<number | null>((resolve, reject) => { child.once('error', () => reject(Error('app_browser_unavailable'))); child.once('exit', resolve); });
    try {
        if (await withDeadline(exited, 5000, 'app browser deadline') !== 0)
            throw Error();
    }
    catch {
        child.kill('SIGKILL');
        await withDeadline(exited.catch(() => null), 1000, 'app browser cleanup').catch(() => { });
        throw Error('app_browser_unavailable');
    }
}
