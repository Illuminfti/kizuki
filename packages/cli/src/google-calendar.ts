import { createGoogleCalendarConnector, inspectGoogleCalendarState, type GoogleCalendarConnectorConfig, type GoogleCalendarConnectorDeps, type GoogleCalendarField } from '@kizuki/connector-google-calendar';
import {openGoogleBrowser} from './google-browser';
import { tokenResolver, validTokenRef } from './secrets';
const FIELDS: readonly GoogleCalendarField[] = ['summary', 'description', 'location', 'attendees', 'attachments'];
export function googleCalendarFields(raw: string | undefined): GoogleCalendarField[] {
    if(raw === 'none') return [];
    const values = raw?.split(',');
    if (!values?.length || values.some(value => !FIELDS.includes(value as GoogleCalendarField)) || new Set(values).size !== values.length)
        throw new Error('Google Calendar requires explicit --fields summary,description,location,attendees,attachments (select the fields to persist).');
    return FIELDS.filter(field => values.includes(field));
}
export async function googleCalendarClient(env: Record<string, string | undefined>): Promise<NonNullable<GoogleCalendarConnectorConfig['client']>> {
    const id = env.KIZUKI_GOOGLE_CALENDAR_CLIENT_ID;
    if (!id || id.length > 512 || !/^[A-Za-z0-9._-]+$/.test(id))
        throw new Error('Google Calendar desktop client is not configured. The operator must configure KIZUKI_GOOGLE_CALENDAR_CLIENT_ID before enrollment.');
    const ref = env.KIZUKI_GOOGLE_CALENDAR_CLIENT_SECRET_REF;
    try {
        if (ref === undefined)
            return { id };
        if (!validTokenRef(ref))
            throw new Error();
        return { id, secret: await tokenResolver(ref, env)(ref) };
    }
    catch {
        throw new Error('Google Calendar desktop client secret reference is unavailable. Repair operator configuration before enrollment.');
    }
}
/** Host policy maps provider-specific selections to native persisted event fields. */
export function googleCalendarRequiredFields(selected: readonly GoogleCalendarField[]): string[] {
    return ['metadata', 'subjects', ...(selected.some(field=>['summary','description','location'].includes(field))?['text']:[]), ...(selected.includes('attachments')?['attachments']:[])];
}
export function googleCalendarStateConfig(bytes: Uint8Array, secret_ref: string, client: NonNullable<GoogleCalendarConnectorConfig['client']>): GoogleCalendarConnectorConfig {
    const state = inspectGoogleCalendarState(bytes);
    return { client, secret_ref, calendar_id: state.calendar_id, fields: state.fields, expected_account: state.account_id };
}
export type GoogleCalendarFactory = (config: GoogleCalendarConnectorConfig, deps: GoogleCalendarConnectorDeps) => ReturnType<typeof createGoogleCalendarConnector>;
export function openGoogleCalendarBrowser(raw:string):Promise<void>{return openGoogleBrowser(raw,'Google Calendar');}

export function googleCalendarId(raw:string|undefined):string{if(!raw||Buffer.byteLength(raw)>1024||raw.toLowerCase()==='primary'||/[\s\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(raw))throw new Error('Google Calendar requires --calendar CANONICAL_ID; primary alias is unsupported.');return raw;}
