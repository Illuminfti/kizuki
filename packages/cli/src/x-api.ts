import { KizukiError, withDeadline } from '@kizuki/core';
import { createXApiConnector, inspectXApiState, normalizeXApiNativeClient, normalizeXApiSelection, type XApiConfig, type XApiDeps, type XApiSelection } from '@kizuki/connectors';

/** Public native-app configuration only. Core owns exact callback validation. */
export function xApiClient(env: Record<string, string | undefined>, state?: ReturnType<typeof inspectXApiState> | null): { id: string; redirectUri: string } {
  if (state?.native_client) return { id: state.native_client.id, redirectUri: state.native_client.redirect_uri };
  const id = env.KIZUKI_X_CLIENT_ID, redirectUri = env.KIZUKI_X_REDIRECT_URI;
  try {
    const client = normalizeXApiNativeClient({ id, redirect_uri: redirectUri });
    return { id: client.id, redirectUri: client.redirect_uri };
  } catch {
    throw new Error('X native app is not configured. Configure KIZUKI_X_CLIENT_ID and KIZUKI_X_REDIRECT_URI as the registered http://127.0.0.1:PORT/callback before enrollment.');
  }
}
export function xApiSelection(fields: string | undefined, historyStart: string | undefined): XApiSelection {
  try {
    if (fields === undefined || historyStart === undefined) throw new Error();
    return normalizeXApiSelection({ fields: fields === 'none' ? [] : fields.split(','), history_start: historyStart, wire_profile: 'tweet-v2' });
  } catch {
    throw new Error('X requires explicit --fields relationships,links,media|none and --history-start RFC3339 (at or after 2010-11-06). Text, metadata and author identity are always included.');
  }
}
/** Host policy maps provider-specific selections to native persisted event fields. Author identity is always retained. */
export function xApiRequiredFields(selected: XApiSelection): string[] {
  return ['text', 'subjects', 'metadata', ...(selected.fields.includes('media') ? ['attachments'] : [])];
}
export function xApiStateConfig(bytes: Uint8Array, secret_ref: string, client: ReturnType<typeof xApiClient>): XApiConfig {
  const state = inspectXApiState(bytes);
  return { client_id: client.id, redirect_uri: client.redirectUri, secret_ref, selection: state.selection, expected_account: state.account_id };
}
export type XApiFactory = (config: XApiConfig, deps: XApiDeps) => ReturnType<typeof createXApiConnector>;

/** Provider allowlist and fixed executable/argv; browser URLs never enter output. */
export async function openXApiBrowser(raw: string): Promise<void> {
  try {
    const url = new URL(raw);
    if (url.origin !== 'https://x.com' || url.pathname !== '/i/oauth2/authorize' || url.username || url.password || url.hash || raw.length > 8192) throw new Error();
    const command = process.platform === 'linux' ? '/usr/bin/xdg-open' : process.platform === 'darwin' ? '/usr/bin/open' : null;
    if (!command) throw new Error();
    const env: Record<string, string> = { PATH: '/usr/bin:/bin' };
    for (const key of ['HOME', 'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CURRENT_DESKTOP'])
      if (process.env[key] !== undefined) env[key] = process.env[key]!;
    const child = Bun.spawn([command, url.href], { env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    try {
      if (await withDeadline(child.exited, 5000, 'X browser launch timeout') !== 0) throw new Error();
    } finally {
      if (child.exitCode === null) { child.kill('SIGKILL'); await withDeadline(child.exited, 1000, 'X browser cleanup timeout'); }
    }
  } catch { throw new KizukiError('unavailable', 'X system browser could not be opened. Use a supported desktop session and retry.'); }
}
