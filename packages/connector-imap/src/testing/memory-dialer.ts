import type { ImapConn, ImapDialer } from "../transport";
import type { FakeImapServer } from "./fake-imap";

/**
 * Wires a `FakeImapServer` to the connector through the same `ImapDialer`
 * seam production uses, so tests exercise the real client without a socket.
 */
export function memoryDialer(server: FakeImapServer): ImapDialer {
  return async (): Promise<ImapConn> => {
    const pending: Uint8Array[] = [server.greeting()];
    const waiters: ((chunk: Uint8Array | null) => void)[] = [];
    let closed = false;

    const deliver = (bytes: Uint8Array): void => {
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(bytes);
      else pending.push(bytes);
    };

    return {
      async send(bytes: Uint8Array): Promise<void> {
        if (closed) return;
        const responses = server.feed(bytes);
        const delay = server.takeDelay();
        if (delay > 0) {
          setTimeout(() => {
            for (const response of responses) deliver(response);
          }, delay);
          return;
        }
        for (const response of responses) deliver(response);
      },
      async receive(): Promise<Uint8Array | null> {
        const chunk = pending.shift();
        if (chunk !== undefined) return chunk;
        if (closed) return null;
        return new Promise<Uint8Array | null>((resolve) => {
          waiters.push(resolve);
        });
      },
      close(): void {
        closed = true;
        while (waiters.length > 0) waiters.shift()?.(null);
      },
    };
  };
}
