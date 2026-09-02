import { KizukiError } from "../errors";
import { MAX_RECORDS, MAX_RECORD_BYTES } from "../util";
import { detectDateOrder, localTimestamp } from "./dates";
import type { DateOrder, RawDate, RawTime } from "./dates";

/**
 * There is no published grammar for the "Export chat" text file, so the shape
 * below is explicit and anything outside it is a named refusal rather than a
 * silent reinterpretation.
 */

export interface ParsedWhatsAppMessage {
  /** First line of the message, 1-based. Diagnostics only; never persisted. */
  line: number;
  local_timestamp: string;
  sender: string;
  text: string;
}

const WS = "[ \u00a0\u202f]";
const DATE =
  "(?:\\d{1,2}/\\d{1,2}/(?:\\d{4}|\\d{2})" +
  "|\\d{1,2}\\.\\d{1,2}\\.(?:\\d{4}|\\d{2})" +
  "|\\d{1,2}-\\d{1,2}-(?:\\d{4}|\\d{2})" +
  "|\\d{4}/\\d{1,2}/\\d{1,2}" +
  "|\\d{4}\\.\\d{1,2}\\.\\d{1,2}" +
  "|\\d{4}-\\d{1,2}-\\d{1,2})";
const SEP1 = `,?${WS}+`;
const MERIDIEM = `(?:${WS}?[AaPp]\\.?${WS}?[Mm]\\.?)?`;
const TIME = `\\d{1,2}:\\d{2}(?::\\d{2})?${MERIDIEM}`;
const TIMESTAMP = `${DATE}${SEP1}${TIME}`;

/**
 * Group 1 is the bracketed timestamp, group 2 the dashed one, group 3 the
 * rest of the line. Exported so tests can exercise the shape directly.
 */
export const MESSAGE_START = new RegExp(
  `^(?:\\[(${TIMESTAMP})\\]${WS}+|(${TIMESTAMP})${WS}*-${WS}+)(.*)$`,
);

const TIMESTAMP_FIELDS = new RegExp(
  `^(\\d{1,4})([/.-])(\\d{1,2})\\2(\\d{1,4})${SEP1}` +
    `(\\d{1,2}):(\\d{2})(?::(\\d{2}))?${WS}?([AaPp])?\\.?${WS}?[Mm]?\\.?$`,
);

const LEADING_MARKS = /^[\u200e\u200f]+/;

interface StartLine {
  line: number;
  date: RawDate;
  time: RawTime;
  rest: string;
}

function stripLeadingMarks(value: string): string {
  return value.replace(LEADING_MARKS, "");
}

function parseTimestamp(
  raw: string,
): { date: RawDate; time: RawTime } | undefined {
  const matched = TIMESTAMP_FIELDS.exec(raw);
  if (matched === null) return undefined;
  const first = matched[1] ?? "";
  const meridiem = matched[8];
  return {
    date: {
      a: Number(first),
      b: Number(matched[3]),
      c: Number(matched[4]),
      wide_first: first.length === 4,
    },
    time: {
      hour: Number(matched[5]),
      minute: Number(matched[6]),
      second: matched[7] === undefined ? null : Number(matched[7]),
      meridiem:
        meridiem === undefined
          ? null
          : meridiem.toLowerCase() === "a"
            ? "am"
            : "pm",
    },
  };
}

/**
 * Splits an export into messages and reports the date order it resolved.
 * System notices — lines with a timestamp but no sender — are dropped: they
 * have no author and make no claim worth writing, so a capture note for each
 * would be noise rather than evidence.
 */
export function splitWhatsAppMessages(
  text: string,
  date_order?: DateOrder,
): { messages: ParsedWhatsAppMessage[]; date_order: DateOrder } {
  // A file's final newline terminates the last message; it is not an
  // empty continuation line inside it.
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = body.split("\n");
  const starts: StartLine[] = [];
  const continuations = new Map<number, string[]>();
  let current: number | undefined;

  lines.forEach((raw, index) => {
    const line = stripLeadingMarks(raw);
    const matched = MESSAGE_START.exec(line);
    const stamp =
      matched === null
        ? undefined
        : parseTimestamp(matched[1] ?? matched[2] ?? "");
    if (matched === null || stamp === undefined) {
      // A continuation before the first start belongs to no message.
      if (current === undefined) return;
      continuations.get(current)?.push(line);
      return;
    }
    starts.push({
      line: index + 1,
      date: stamp.date,
      time: stamp.time,
      rest: matched[3] ?? "",
    });
    current = starts.length - 1;
    continuations.set(current, []);
  });

  if (starts.length === 0) {
    throw new KizukiError(
      "parse_error",
      "not a WhatsApp chat export (no timestamped line found)",
    );
  }
  if (starts.length > MAX_RECORDS) {
    throw new KizukiError(
      "parse_error",
      `export holds more than ${MAX_RECORDS} messages`,
    );
  }

  const order =
    date_order ?? detectDateOrder(starts.map((start) => start.date));

  const messages: ParsedWhatsAppMessage[] = [];
  starts.forEach((start, index) => {
    const stamp = localTimestamp(start.date, start.time, order, start.line);
    const cut = start.rest.indexOf(": ");
    if (cut <= 0) return;
    const body = [
      stripLeadingMarks(start.rest.slice(cut + 2)),
      ...(continuations.get(index) ?? []),
    ].join("\n");
    if (Buffer.byteLength(body, "utf8") > MAX_RECORD_BYTES) {
      throw new KizukiError(
        "parse_error",
        `line ${start.line}: message exceeds ${MAX_RECORD_BYTES} bytes`,
      );
    }
    messages.push({
      line: start.line,
      local_timestamp: stamp,
      sender: start.rest.slice(0, cut).trim(),
      text: body,
    });
  });

  return { messages, date_order: order };
}
