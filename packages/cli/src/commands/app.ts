import { startServeHttp } from '@kizuki/core';
import { parseArguments, UsageError } from '../args';
import { createAppHost } from '../app/host';
import { openAppBrowser } from '../app/browser';
import { appAssets } from '../app/assets';
import type { CliIo, Command } from './index';
export async function startApp(io: CliIo, options: {
    open?: boolean;
} = {}, launch: typeof openAppBrowser = openAppBrowser) {
    const host = createAppHost(io), server = startServeHttp({ mode: 'app', assets: appAssets, handle: host.handle });
    try {
        if (options.open !== false)
            await launch(server.url + '/#token=' + server.token);
    }
    catch {
        await server.stop();
        await host.close();
        throw Error('app_browser_unavailable');
    }
    return { url: server.url, async close() { await server.stop(); await host.close(); } };
}
export const appCommand: Command = { name: 'app', usage: 'app [--no-open] [--no-service]', summary: 'open the private local app without starting another writer', async run(io, args) {
        const parsed = parseArguments(args, { flags: ['--no-open', '--no-service'] });
        if (parsed.positionals.length)
            throw new UsageError(this.usage);
        const app = await startApp(io, { open: !parsed.flags.has('--no-open') });
        io.out(`Kizuki app: ${app.url}`);
        io.out('Local client only; press Ctrl-C to close. No background service is installed by app setup.');
        try {
            await new Promise<void>(resolve => { const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); resolve(); }; process.once('SIGINT', stop); process.once('SIGTERM', stop); });
        }
        finally {
            await app.close();
        }
        return 0;
    } };
