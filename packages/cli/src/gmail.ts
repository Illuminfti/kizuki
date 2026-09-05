import { createGmailConnector, inspectGmailState, type GmailConnectorConfig, type GmailConnectorDeps, type GmailField } from '@kizuki/connector-gmail';
import { KizukiError, withDeadline } from '@kizuki/core';
import { tokenResolver, validTokenRef } from './secrets';
const FIELDS: readonly GmailField[] = ['text', 'subjects', 'headers', 'labels', 'attachments'];
export function gmailFields(raw: string | undefined): GmailField[] {
    const values = raw?.split(',');
    if (!values?.length || values.some(value => !FIELDS.includes(value as GmailField)) || new Set(values).size !== values.length)
        throw new Error('Gmail requires explicit --fields text,subjects,headers,labels,attachments (select the fields to persist).');
    return FIELDS.filter(field => values.includes(field));
}
export async function gmailClient(env: Record<string, string | undefined>): Promise<NonNullable<GmailConnectorConfig['client']>> {
    const id = env.KIZUKI_GMAIL_CLIENT_ID;
    if (!id || id.length > 512 || !/^[A-Za-z0-9._-]+$/.test(id))
        throw new Error('Gmail desktop client is not configured. The operator must configure KIZUKI_GMAIL_CLIENT_ID before enrollment.');
    const ref = env.KIZUKI_GMAIL_CLIENT_SECRET_REF;
    try {
        if (ref === undefined)
            return { id };
        if (!validTokenRef(ref))
            throw new Error();
        return { id, secret: await tokenResolver(ref, env)(ref) };
    }
    catch {
        throw new Error('Gmail desktop client secret reference is unavailable. Repair operator configuration before enrollment.');
    }
}
/** Host policy maps provider-specific selections to native persisted event fields. */
export function gmailRequiredFields(selected: readonly GmailField[]): string[] {
    return ['metadata', ...selected.filter(field => field === 'text' || field === 'subjects' || field === 'attachments')];
}
export function gmailStateConfig(bytes: Uint8Array, secret_ref: string, client: NonNullable<GmailConnectorConfig['client']>): GmailConnectorConfig {
    const state = inspectGmailState(bytes);
    return { client, secret_ref, fields: state.fields, expected_account: state.account_id };
}
export type GmailFactory = (config: GmailConnectorConfig, deps: GmailConnectorDeps) => ReturnType<typeof createGmailConnector>;
/** Fixed executable and argv; no shell, provider text, URL echo or copied credentials. */
export async function openGmailBrowser(raw: string): Promise<void> {
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
            if (await withDeadline(child.exited, 5000, 'Gmail browser launch timeout') !== 0)
                throw new Error();
        }
        finally {
            if (child.exitCode === null) {
                child.kill('SIGKILL');
                await withDeadline(child.exited, 1000, 'Gmail browser cleanup timeout');
            }
        }
    }
    catch {
        throw new KizukiError('unavailable', 'Gmail system browser could not be opened. Use a supported desktop session and retry.');
    }
}
