import type { Database } from 'bun:sqlite';
import { accept } from '../../src/ledger/ledger';
import { validEvent } from '../fixtures';
import { storeClaim, write } from '../canon/helpers';
import type { CanonIo } from '../../src/canon/store';
import type { InsertClaimInput } from '../../src/claims/store';
import { eventFacts } from '../claims/helpers';

export const SUBJECT = `person:${'a'.repeat(64)}`;
export const LABEL = 'Ada Example';
export function labelEvent(db: Database, subject = SUBJECT, sensitivity: 'public' | 'personal' | 'private' = 'public', text = 'Orchard evidence from a synthetic source.'): string {
  const result = accept(db, { ...validEvent(), source_record_id: crypto.randomUUID(),
    text, subjects: [{ subject_id: subject, role: 'from', display_name: 'UNTRUSTED_CAPTURE_NAME' }],
    sensitivity_hint: sensitivity, metadata: { display_name: 'UNTRUSTED_METADATA_NAME' } });
  if (result.status !== 'stored') throw Error('synthetic capture failed');
  return result.event.event_id;
}
/** Real capture -> claim admission -> arbiter -> canonical writer. */
export async function writeIdentity(io: CanonIo, options: Partial<InsertClaimInput> & { written?: boolean; eventId?: string } = {}) {
  const { written = true, eventId, ...overrides } = options;
  const subject = overrides.subject ?? SUBJECT;
  const event = eventId ?? labelEvent(io.db, subject!, overrides.sensitivity ?? 'public');
  const claim = await storeClaim(io.db, event, { target: `people/${subject!.slice('person:'.length)}`, subject,
    predicate: 'identity.display_name', object: LABEL, body: `Orchard belief ${overrides.predicate ?? 'identity.display_name'}: ${overrides.object ?? LABEL}.`,
    frontmatter: { type: 'person', subjects: [subject!] }, subjects: [subject!], sensitivity: 'public',
    valid_from: '2020-01-01T00:00:00Z', events: [eventFacts(event)], ...overrides });
  const receipt = written ? write(io, claim) : null;
  return { claim, receipt, event };
}
