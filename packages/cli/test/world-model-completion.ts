import { defaultChatCompletion, type SeenRequest } from '../../llm/test/fake-endpoint';

/** Synthetic provider response bound to the real producer/v2 event fence. */
export function worldModelCompletion(request: SeenRequest, value: string, rendering: string, allowConnectionTest = false): Response {
    const body = request.body as { messages: { content: string }[] };
    const prompt = body.messages.map(message => message.content).join('\n');
    const eventId = /event:([0-9A-HJKMNP-TV-Z]{26})/.exec(prompt)?.[1];
    if (eventId === undefined) {
        if (allowConnectionTest) return defaultChatCompletion('Synthetic connection works.');
        throw Error('synthetic extraction request is missing its bound evidence');
    }
    const anchor = { event_id: eventId, start_utf16: 0, end_utf16: 3 };
    return defaultChatCompletion(JSON.stringify({
        schema: 'kizuki.producer-response/v2', mentions: [{ id: 'm0', label: 'Ada', anchor, candidate_refs: [] }],
        claims: [{ id: 'c0', subject: { kind: 'mention', id: 'm0' }, predicate: 'employment.role',
            object: { kind: 'literal', value }, body: rendering, polarity: 'positive',
            perspective: { holder: null, speaker: null, addressee: null, mode: 'asserted', interpretation: 'explicit', anchors: [] },
            context: [], valid_from: null, valid_to: null, temporal_basis: 'unknown',
            confidence: 0.7, sensitivity: 'private', anchors: [anchor] }],
    }));
}
