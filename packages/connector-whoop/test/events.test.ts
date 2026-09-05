import { expect, test } from 'bun:test';
import { validateEventInput } from '@kizuki/core';
import { recordEvent } from '../src/events';
const record = {
    id: 12, user_id: 7, created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-03T00:00:00Z', start: '2026-01-01T01:00:00Z', end: null, timezone_offset: '+01:00', score_state: 'SCORED', score: {
        strain: 0, average_heart_rate: null
    }
};
test('actual typed zero, null and missing metrics remain distinct from clinical interpretation', () => {
    const event = recordEvent('cycle', record, '7', ['metrics', 'activity'], '2026-02-01T00:00:00Z');
    expect(validateEventInput(event).ok).toBe(true);
    expect(event.metadata.metrics).toEqual({
        strain: 0, average_heart_rate: null
    });
    expect(event.occurred_at).toBe(record.updated_at);
    expect(event.metadata.activity).toEqual({
        start: record.start, end: null, timezone_offset: '+01:00'
    });
    expect(event.text).not.toContain('healthy');
    expect(event.text).not.toContain('diagnosis');
    expect(event.sensitivity_hint).toBe('private');
});
test('revision changes preserve account/resource identity, activity start is not provider update time', () => {
    const first = recordEvent('cycle', record, '7', ['metrics'], '2026-02-01T00:00:00Z');
    const next = recordEvent('cycle', {
        ...record, updated_at: '2026-01-04T00:00:00Z', score: {
            strain: 2
        }
    }, '7', ['metrics'], '2026-02-02T00:00:00Z');
    expect(next.source_record_id).toBe(first.source_record_id);
    expect(next.text).not.toBe(first.text);
    expect(first.metadata.activity).toBeUndefined();
    expect(first.metadata.provider_created_at).toBe(record.created_at);
});
test('recovery uses cycle revision time; sleep validity stays unknown without a separate permitted record', () => {
    const event = recordEvent('recovery', {
        cycle_id: 12, sleep_id: '11111111-1111-4111-8111-111111111111', user_id: 7, created_at: record.created_at, updated_at: record.updated_at, score_state: 'PENDING_SCORE', score: null
    }, '7', ['metrics', 'activity'], '2026-02-01T00:00:00Z');
    expect(event.occurred_at).toBe(record.updated_at);
    expect(event.metadata.metrics).toBeNull();
    expect(event.metadata.activity).toBeNull();
    expect(event.deleted).toBe(false);
});
test('cross-account identity, unsafe numeric IDs and malformed selected metrics fail closed', () => {
    for (const bad of [{
            ...record, user_id: 8
        }, {
            ...record, id: 9007199254740992
        }, {
            ...record, score: {
                strain: '0'
            }
        }, {
            ...record, score: {
                strain: NaN
            }
        }, {
            ...record, updated_at: 'tomorrow'
        }])
        expect(() => recordEvent('cycle', bad, '7', ['metrics'], '2026-02-01T00:00:00Z')).toThrow();
});
