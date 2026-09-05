import type { CaptureEventInput, SubjectRef, AttachmentRef } from "@kizuki/core";
import { GMAIL_CONNECTOR_ID, failure, historyId, id, object, type Field, type Change } from "./state";
export function recordId(account: string, message: string): string {
    return Buffer.from(JSON.stringify([id(account), id(message)])).toString("base64url");
}
function string(value: unknown, max = 4096): string {
    if (typeof value !== "string" || Buffer.byteLength(value) > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
        throw failure();
    return value;
}
export function messageEvent(account: string, raw: unknown, observed: string, selected: readonly Field[]): CaptureEventInput {
    const m = object(raw);
    const message = id(m.id);
    if (typeof m.internalDate !== "string" || !/^[0-9]{1,16}$/.test(m.internalDate))
        throw failure("malformed_record");
    const ms = Number(m.internalDate);
    if (!Number.isSafeInteger(ms) || ms > 253402300799999)
        throw failure("malformed_record");
    const occurred = new Date(ms).toISOString();
    const labels = m.labelIds === undefined ? [] : m.labelIds;
    if (!Array.isArray(labels) || labels.length > 256)
        throw failure();
    const metadata: Record<string, unknown> = { message_id: message, thread_id: id(m.threadId), history_id: historyId(m.historyId), occurred_at_semantics: "provider_internal_date", attachments_downloaded: false };
    if (selected.includes("labels"))
        metadata.labels = [...new Set(labels.map(v => string(v, 256)))].sort();
    const subjects: SubjectRef[] = [];
    const attachments: AttachmentRef[] = [];
    const texts: string[] = [];
    const headers: Record<string, string> = {};
    const coverage = new Set<string>(["mime_projection_limited_depth_8"]);
    let nodes = 0, bytes = 0;
    const walk = (value: unknown, depth: number): void => {
        if (depth > 8 || ++nodes > 128)
            throw failure("malformed_record");
        const p = object(value);
        const mime = p.mimeType === undefined ? "application/octet-stream" : string(p.mimeType, 256).toLowerCase();
        const hs = p.headers ?? [];
        if (!Array.isArray(hs) || hs.length > 256)
            throw failure();
        let contentType = mime;
        for (const rawHeader of hs) {
            const h = object(rawHeader);
            const name = string(h.name, 128).toLowerCase();
            if (!["from", "to", "cc", "subject", "date", "content-type"].includes(name))
                continue;
            const val = string(h.value);
            if (name === "content-type")
                contentType = val.toLowerCase();
            if (depth === 0 && selected.includes("headers"))
                headers[name] = val;
            if (depth === 0 && selected.includes("subjects") && ["from", "to", "cc"].includes(name)) {
                for (const match of val.matchAll(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
                    if (subjects.length >= 64) {
                        coverage.add("participants_truncated");
                        break;
                    }
                    const email = match[0].toLowerCase();
                    if (email.length <= 254)
                        subjects.push({ subject_id: `email:${email}`, role: name === "from" ? "from" : "to" });
                }
            }
        }
        const body = p.body === undefined ? {} : object(p.body);
        const filename = p.filename === undefined ? "" : string(p.filename, 1024);
        if (filename || body.attachmentId !== undefined) {
            coverage.add("attachment_body_unsupported");
            if (selected.includes("attachments")) {
                const attachment_id = body.attachmentId === undefined ? `part:${string(p.partId, 256)}` : string(body.attachmentId, 1024);
                const ref: AttachmentRef = { attachment_id, media_type: mime };
                if (filename)
                    ref.filename = filename;
                if (body.size !== undefined) {
                    if (!Number.isSafeInteger(body.size) || (body.size as number) < 0)
                        throw failure();
                    ref.byte_size = body.size as number;
                }
                attachments.push(ref);
            }
        }
        else if (selected.includes("text") && body.data !== undefined) {
            if (mime !== "text/plain")
                coverage.add("non_plain_body_unsupported");
            else if (/charset\s*=\s*["']?(?!utf-8\b|us-ascii\b)[a-z0-9_-]+/i.test(contentType))
                coverage.add("charset_unsupported");
            else {
                if (typeof body.data !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(body.data))
                    throw failure();
                const decoded = Buffer.from(body.data, "base64url");
                if (bytes + decoded.byteLength > 65536)
                    coverage.add("body_size_unsupported");
                else {
                    try {
                        texts.push(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
                        bytes += decoded.byteLength;
                    }
                    catch {
                        throw failure("malformed_record");
                    }
                }
            }
        }
        if (p.parts !== undefined) {
            if (!Array.isArray(p.parts) || p.parts.length > 128)
                throw failure();
            for (const part of p.parts)
                walk(part, depth + 1);
        }
    };
    if (m.payload !== undefined)
        walk(m.payload, 0);
    if (selected.includes("headers"))
        metadata.headers = headers;
    metadata.body_coverage = selected.includes("text") ? [...coverage].sort() : ["body_not_selected"];
    return { schema: "kizuki.event/v1", connector_id: GMAIL_CONNECTOR_ID, source_record_id: recordId(account, message), kind: "email", occurred_at: occurred, observed_at: observed, text: texts.join("\n"), subjects, attachments, metadata, sensitivity_hint: "private", deleted: false };
}
export function tombstoneEvent(account: string, change: Change, observed: string): CaptureEventInput {
    return { schema: "kizuki.event/v1", connector_id: GMAIL_CONNECTOR_ID, source_record_id: recordId(account, change.id), kind: "email", occurred_at: observed, observed_at: observed, text: "", subjects: [], attachments: [], sensitivity_hint: "private", deleted: true, metadata: { message_id: change.id, history_id: change.history, occurred_at_semantics: "deletion_observed", provider_deleted_at: null } };
}
/** Provider-side partial response, in addition to the separately enforced persisted-field selection. */
export function messageProjection(selected: readonly Field[]): string {
    let part = ["partId", "mimeType", ...(selected.includes("attachments") ? ["filename"] : []), "headers(name,value)", selected.includes("text") ? "body(data,size,attachmentId)" : "body(size,attachmentId)"].join(",");
    const leaf = part;
    for (let depth = 0; depth < 8; depth++)
        part = `${leaf},parts(${part})`;
    return `id,threadId,historyId,internalDate${selected.includes("labels") ? ",labelIds" : ""},payload(${part})`;
}
