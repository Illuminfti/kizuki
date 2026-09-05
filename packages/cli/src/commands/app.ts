import { startServeHttp } from '@kizuki/core';
import { parseArguments, UsageError } from '../args';
import { createAppHost } from '../app/host';
import { openAppBrowser } from '../app/browser';
import { appAssets } from '../app/assets';
import type { CliIo, Command } from './index';
export async function startApp(io: CliIo, options: {
    open?: boolean;
    noService?: boolean;
} = {}, launch: typeof openAppBrowser = openAppBrowser) {
    let connected = false;
    // Core authenticates requests before dispatching to this host; assets and
    // unauthenticated traffic never enter the admitted-request callback.
    const host = createAppHost(io, { onRequest: () => { connected = true; } }, options), server = startServeHttp({ mode: 'app', assets: appAssets, handle: host.handle });
    try {
        if (options.open !== false)
            await launch(server.url + '/#token=' + server.token, () => connected);
    }
    catch {
        if (!connected) {
            await server.stop();
            await host.close();
            throw Error('app_browser_unavailable');
        }
    }
    return { url: server.url, async close() { await server.stop(); await host.close(); } };
}
export const appCommand: Command = { name: 'app', usage: 'app [--no-open] [--no-service]', summary: 'open the private local app without starting another writer', async run(io, args) {
        const parsed = parseArguments(args, { flags: ['--no-open', '--no-service'] });
        if (parsed.positionals.length)
            throw new UsageError(this.usage);
        const app = await startApp(io, { open: !parsed.flags.has('--no-open'), noService: parsed.flags.has('--no-service') });
        io.out(`Kizuki app: ${app.url}`);
        io.out('Press Ctrl-C to close the app. First-run setup installs the native background service unless you explicitly opt out.');
        try {
            await new Promise<void>(resolve => { const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); resolve(); }; process.once('SIGINT', stop); process.once('SIGTERM', stop); });
        }
        finally {
            await app.close();
        }
        return 0;
    } };
