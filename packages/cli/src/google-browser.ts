import { KizukiError, withDeadline } from '@kizuki/core';
/** Fixed executable and argv; no shell, provider text, URL echo or copied credentials. */
export async function openGoogleBrowser(raw: string, label: "Gmail" | "Google Calendar"): Promise<void> {
    try {
        const url = new URL(raw);
        if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' || url.username || url.password || url.hash || raw.length > 8192)
            throw new Error();
        const command = process.platform === 'linux' ? '/usr/bin/xdg-open' : process.platform === 'darwin' ? '/usr/bin/open' : null;
        if (!command)
            throw new Error();
        const env: Record<string, string> = { PATH: '/usr/bin:/bin' };
        for (const key of ['HOME', 'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CURRENT_DESKTOP'])
            if (process.env[key] !== undefined)
                env[key] = process.env[key]!;
        const child = Bun.spawn([command, url.href], { env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
        try {
            if (await withDeadline(child.exited, 5000, `${label} browser launch timeout`) !== 0)
                throw new Error();
        }
        finally {
            if (child.exitCode === null) {
                child.kill('SIGKILL');
                await withDeadline(child.exited, 1000, `${label} browser cleanup timeout`);
            }
        }
    }
    catch {
        throw new KizukiError('unavailable', `${label} system browser could not be opened. Use a supported desktop session and retry.`);
    }
}
