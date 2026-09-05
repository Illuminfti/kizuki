import { createGmailConnector, inspectGmailState, type GmailConnectorConfig, type GmailConnectorDeps, type GmailField } from '@kizuki/connector-gmail';
import {openGoogleBrowser} from './google-browser';
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
export function openGmailBrowser(raw:string):Promise<void>{return openGoogleBrowser(raw,'Gmail');}
