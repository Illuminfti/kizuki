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

/** What an export of notices alone is reported as: it dates nothing, so
 * nothing about it depends on the answer. */
const DEFAULT_DATE_ORDER: DateOrder = "dmy";

interface StartLine {
  line: number;
  date: RawDate;
  time: RawTime;
  /** `null` for a system notice: a timestamped line with nothing before its
   * first colon-and-space, so no author and no claim worth writing. */
  sender: string | null;
  /** What the message says on its own start line; empty for a notice. */
  text: string;
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
  // A file's last line ends with a line terminator, and that terminator is not
  // an empty line inside the last message. Anything after it is: a blank
  // continuation line is part of what a message says, and a message is
  // identified by what it says.
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
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
    const rest = matched[3] ?? "";
    const cut = rest.indexOf(": ");
    const sender = cut > 0 ? rest.slice(0, cut).trim() : null;
    starts.push({
      line: index + 1,
      date: stamp.date,
      time: stamp.time,
      sender,
      text: sender === null ? "" : rest.slice(cut + 2),
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

  // A notice is dropped before the dates are read, so neither its own date nor
  // an unparsable one inside it settles or refuses an import of the messages
  // around it: an export holding nothing but notices is empty, not an error.
  const dated = starts.filter((start) => start.sender !== null);
  const order =
    date_order ??
    (dated.length > 0
      ? detectDateOrder(dated.map((start) => start.date))
      : DEFAULT_DATE_ORDER);

  const messages: ParsedWhatsAppMessage[] = [];
  starts.forEach((start, index) => {
    const sender = start.sender;
    if (sender === null) return;
    const stamp = localTimestamp(start.date, start.time, order, start.line);
    const body = [
      stripLeadingMarks(start.text),
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
