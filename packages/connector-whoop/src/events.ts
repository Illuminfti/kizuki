import type { CaptureEventInput } from '@kizuki/core';
import { WHOOP_ID, integerId, instant, object, failure, type Resource, type Field } from './state';
const NUMBERS: Record<Resource, readonly string[]> = {
    cycle: ['strain', 'kilojoule', 'average_heart_rate', 'max_heart_rate'], recovery: ['recovery_score', 'resting_heart_rate', 'hrv_rmssd_milli', 'spo2_percentage', 'skin_temp_celsius'], sleep: ['respiratory_rate', 'sleep_performance_percentage', 'sleep_consistency_percentage', 'sleep_efficiency_percentage'], workout: ['strain', 'average_heart_rate', 'max_heart_rate', 'kilojoule', 'percent_recorded', 'distance_meter', 'altitude_gain_meter', 'altitude_change_meter']
};
const NESTED: Record<string, readonly string[]> = {
    stage_summary: ['total_in_bed_time_milli', 'total_awake_time_milli', 'total_no_data_time_milli', 'total_light_sleep_time_milli', 'total_slow_wave_sleep_time_milli', 'total_rem_sleep_time_milli', 'sleep_cycle_count', 'disturbance_count'], sleep_needed: ['baseline_milli', 'need_from_sleep_debt_milli', 'need_from_recent_strain_milli', 'need_from_recent_nap_milli'], zone_durations: ['zone_zero_milli', 'zone_one_milli', 'zone_two_milli', 'zone_three_milli', 'zone_four_milli', 'zone_five_milli']
};
function numeric(raw: unknown, keys: readonly string[]): Record<string, number | null> {
    const input = object(raw), out: Record<string, number | null> = {};
    for (const key of keys)
        if (Object.hasOwn(input, key)) {
            const value = input[key];
            if (value !== null && (typeof value !== 'number' || !Number.isFinite(value)))
                throw failure();
            out[key] = value as number | null;
        }
    return out;
}
function metrics(raw: unknown, resource: Resource): Record<string, unknown> | null {
    if (raw === null)
        return null;
    const input = object(raw), out: Record<string, unknown> = numeric(input, NUMBERS[resource]);
    if (resource === 'recovery' && Object.hasOwn(input, 'user_calibrating')) {
        if (typeof input.user_calibrating !== 'boolean' && input.user_calibrating !== null)
            throw failure();
        out.user_calibrating = input.user_calibrating;
    }
    for (const key of resource === 'sleep' ? ['stage_summary', 'sleep_needed'] : resource === 'workout' ? ['zone_durations'] : []) {
        if (Object.hasOwn(input, key))
            out[key] = input[key] === null ? null : numeric(input[key], NESTED[key]!);
    }
    return out;
}
function uuid(value: unknown): string {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
        throw failure();
    return value.toLowerCase();
}
export function recordEvent(resource: Resource, raw: unknown, account: string, fields: readonly Field[], observed: string): CaptureEventInput {
    const r = object(raw);
    if (integerId(r.user_id) !== account)
        throw failure('identity_mismatch');
    const id = resource === 'cycle' ? integerId(r.id) : resource === 'recovery' ? integerId(r.cycle_id) : uuid(r.id);
    const created = instant(r.created_at), updated = instant(r.updated_at);
    if (Date.parse(updated) < Date.parse(created))
        throw failure();
    if (!['SCORED', 'PENDING_SCORE', 'UNSCORABLE'].includes(r.score_state as string))
        throw failure();
    const metadata: Record<string, unknown> = {
        provider: 'whoop', resource, provider_created_at: created, provider_updated_at: updated, score_state: r.score_state
    };
    if (resource === 'recovery')
        metadata.sleep_id = uuid(r.sleep_id);
    if (fields.includes('metrics') && Object.hasOwn(r, 'score'))
        metadata.metrics = metrics(r.score, resource);
    if (fields.includes('activity')) {
        if (resource === 'recovery')
            metadata.activity = null;
        else {
            const start = instant(r.start), end = r.end === null ? null : instant(r.end);
            if (end !== null && Date.parse(end) < Date.parse(start))
                throw failure();
            if (typeof r.timezone_offset !== 'string' || !/^[+-](?:0[0-9]|1[0-4]):[0-5][0-9]$/.test(r.timezone_offset))
                throw failure();
            const activity: Record<string, unknown> = {
                start, end, timezone_offset: r.timezone_offset
            };
            if (resource === 'sleep') {
                if (typeof r.nap !== 'boolean')
                    throw failure();
                activity.nap = r.nap;
            }
            if (resource === 'workout') {
                if (typeof r.sport_id !== 'number' || !Number.isSafeInteger(r.sport_id))
                    throw failure();
                activity.sport_id = r.sport_id;
            }
            metadata.activity = activity;
        }
    }
    return {
        schema: 'kizuki.event/v1', connector_id: WHOOP_ID, source_record_id: `whoop:${account}:${resource}:${id}`, kind: 'health', occurred_at: updated, observed_at: instant(observed), text: `WHOOP ${resource} record (${r.score_state}).${Object.hasOwn(metadata, 'metrics') ? ` Reported measurements: ${JSON.stringify(metadata.metrics)}.` : ''}`, subjects: [{
                subject_id: `person:whoop:${account}`, role: 'about'
            }], sensitivity_hint: 'private', deleted: false, attachments: [], metadata
    };
}
