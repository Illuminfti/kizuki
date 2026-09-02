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
  // The newlines a file ends with terminate the last message; they are not
  // empty continuation lines inside it. A saved-over export that gained or
  // lost a final blank line would otherwise change that message's text, and
  // text is hashed, so the same chat would fork its last record.
  const body = text.replace(/\n+$/, "");
  const lines = body.split("\n");
  const starts: StartLine[] = [];
  const continuations = new Map<number, string[]>();
  let current: number | undefined;
  let currentLine = 0;
  let carried = 0;

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
      // What a message has gathered so far, charged as it gathers: a message
      // runs until the next timestamped line, so an export with none can
      // otherwise assemble the whole file into one record before it is
      // weighed.
      carried += Buffer.byteLength(line, "utf8") + 1;
      if (carried > MAX_RECORD_BYTES) {
        throw new KizukiError(
          "parse_error",
          `line ${currentLine}: message exceeds ${MAX_RECORD_BYTES} bytes`,
        );
      }
      continuations.get(current)?.push(line);
      return;
    }
    if (starts.length >= MAX_RECORDS) {
      throw new KizukiError(
        "parse_error",
        `export holds more than ${MAX_RECORDS} messages`,
      );
    }
    starts.push({
      line: index + 1,
      date: stamp.date,
      time: stamp.time,
      rest: matched[3] ?? "",
    });
    current = starts.length - 1;
    currentLine = index + 1;
    carried = 0;
    continuations.set(current, []);
  });

  if (starts.length === 0) {
    throw new KizukiError(
      "parse_error",
      "not a WhatsApp chat export (no timestamped line found)",
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
    // A sender becomes a subject and a display name, so it is a captured
    // field like any other and carries the same bound.
    const sender = start.rest.slice(0, cut).trim();
    if (Buffer.byteLength(sender, "utf8") > MAX_RECORD_BYTES) {
      throw new KizukiError(
        "parse_error",
        `line ${start.line}: sender exceeds ${MAX_RECORD_BYTES} bytes`,
      );
    }
    messages.push({
      line: start.line,
      local_timestamp: stamp,
      sender,
      text: body,
    });
  });

  return { messages, date_order: order };
}
