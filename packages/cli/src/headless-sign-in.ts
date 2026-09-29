import { ConnectionError } from './connections';
import type { CliIo } from './commands';

/**
 * Wraps a system browser opener for OAuth sign-ins that must also work on a
 * server with no desktop. When the opener is skipped (`noBrowser`) or fails,
 * the authorization address goes to stderr with the ssh tunnel that carries
 * the loopback callback back to this machine, and sign-in keeps waiting for
 * that callback. Opener diagnostics are never relayed.
 */
export function headlessBrowserOpener(io: Pick<CliIo, 'err'>, open: (url: string) => Promise<void>, noBrowser = false): (url: string) => Promise<void> {
  return async raw => {
    if (!noBrowser) {
      try { await open(raw); return; }
      catch { /* Fall through to the printed address. */ }
    }
    let url: URL;
    try { url = new URL(raw); } catch { throw new ConnectionError('sign-in address is not a valid URL'); }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') throw new ConnectionError('sign-in address must be a plain https URL');
    io.err(noBrowser ? 'Browser launch skipped (--no-browser).' : 'No browser could be opened on this machine.');
    io.err('Open this address in a browser on any device and finish signing in there:');
    io.err(url.href);
    const port = callbackPort(url);
    if (port !== null) {
      io.err(`The provider sends the browser back to 127.0.0.1:${port} on this machine. From the device with the browser, forward that port first:`);
      io.err(`  ssh -L ${port}:127.0.0.1:${port} <host>`);
    }
    io.err('Still waiting for the sign-in to complete. Press Ctrl-C to cancel.');
  };
}

function callbackPort(authorization: URL): string | null {
  try {
    const redirect = new URL(authorization.searchParams.get('redirect_uri') ?? '');
    return redirect.port !== '' && /^[0-9]{1,5}$/.test(redirect.port) ? redirect.port : null;
  } catch { return null; }
}
