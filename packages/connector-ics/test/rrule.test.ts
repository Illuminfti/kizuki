import { describe, expect, test } from "bun:test";
import { formatLocal, parseLocal } from "../src/datetime";
import { expand, parseRrule } from "../src/rrule";
import type { RecurrenceRule } from "../src/rrule";

function rule(value: string): RecurrenceRule {
  const parsed = parseRrule(value);
  if ("unsupported" in parsed) {
    throw new Error(`expected a supported rule, got ${parsed.unsupported}`);
  }
  return parsed.rule;
}

function starts(
  value: string,
  dtstart: string,
  options: {
    windowEnd?: string;
    exdates?: string[];
    rdates?: string[];
    maxInstances?: number;
    maxSteps?: number;
  } = {},
): string[] {
  const result = expand(rule(value), parseLocal(dtstart), {
    windowEnd: parseLocal(options.windowEnd ?? "20281231T000000"),
    maxInstances: options.maxInstances ?? 1_000,
    exdates: new Set(options.exdates ?? []),
    rdates: (options.rdates ?? []).map((entry) => parseLocal(entry)),
    maxSteps: options.maxSteps ?? 100_000,
  });
  return result.instances.map((instance) => formatLocal(instance));
}

describe("rule parsing", () => {
  test("accepts the supported subset with its defaults", () => {
    expect(rule("FREQ=WEEKLY")).toEqual({
      freq: "WEEKLY",
      interval: 1,
      wkst: 1,
    });
    expect(rule("FREQ=MONTHLY;INTERVAL=2;COUNT=3;WKST=SU")).toMatchObject({
      freq: "MONTHLY",
      interval: 2,
      count: 3,
      wkst: 0,
    });
    expect(rule("FREQ=WEEKLY;BYDAY=MO,-1FR").byday).toEqual([
      { ordinal: null, weekday: 1 },
      { ordinal: -1, weekday: 5 },
    ]);
    expect(rule("FREQ=YEARLY;BYMONTH=1,6;BYMONTHDAY=-1")).toMatchObject({
      bymonth: [1, 6],
      bymonthday: [-1],
    });
  });

  test("parses UNTIL in both UTC and DATE form", () => {
    expect(rule("FREQ=DAILY;UNTIL=20260310T000000Z").until).toEqual({
      kind: "utc",
      iso: "2026-03-10T00:00:00.000Z",
    });
    expect(rule("FREQ=DAILY;UNTIL=20260310").until).toEqual({
      kind: "date",
      date: "20260310",
    });
  });

  test.each([
    "FREQ=HOURLY",
    "FREQ=MINUTELY",
    "FREQ=SECONDLY",
    "FREQ=WEEKLY;BYSETPOS=1",
    "FREQ=YEARLY;BYYEARDAY=100",
    "FREQ=WEEKLY;BYWEEKNO=3",
    "FREQ=DAILY;BYHOUR=9",
    "FREQ=DAILY;UNTIL=whenever",
    "FREQ=DAILY;INTERVAL=0",
  ])("reports %s as unsupported", (value) => {
    expect(parseRrule(value)).toHaveProperty("unsupported");
  });
});

describe("RFC 5545 expansion vectors", () => {
  test("daily for 10 occurrences", () => {
    expect(starts("FREQ=DAILY;COUNT=10", "19970902T090000")).toEqual([
      "19970902T090000",
      "19970903T090000",
      "19970904T090000",
      "19970905T090000",
      "19970906T090000",
      "19970907T090000",
      "19970908T090000",
      "19970909T090000",
      "19970910T090000",
      "19970911T090000",
    ]);
  });

  test("every other day until a date", () => {
    expect(
      starts("FREQ=DAILY;INTERVAL=2;UNTIL=19970910T000000Z", "19970902T090000"),
    ).toEqual([
      "19970902T090000",
      "19970904T090000",
      "19970906T090000",
      "19970908T090000",
    ]);
  });

  test("weekly on Tuesday and Thursday for four weeks", () => {
    expect(
      starts("FREQ=WEEKLY;COUNT=8;WKST=SU;BYDAY=TU,TH", "19970902T090000"),
    ).toEqual([
      "19970902T090000",
      "19970904T090000",
      "19970909T090000",
      "19970911T090000",
      "19970916T090000",
      "19970918T090000",
      "19970923T090000",
      "19970925T090000",
    ]);
  });

  test("every other week on Monday, Wednesday and Friday", () => {
    expect(
      starts(
        "FREQ=WEEKLY;INTERVAL=2;COUNT=6;WKST=SU;BYDAY=MO,WE,FR",
        "19970901T090000",
      ),
    ).toEqual([
      "19970901T090000",
      "19970903T090000",
      "19970905T090000",
      "19970915T090000",
      "19970917T090000",
      "19970919T090000",
    ]);
  });

  test("monthly on the first Friday for five occurrences", () => {
    expect(starts("FREQ=MONTHLY;COUNT=5;BYDAY=1FR", "19970905T090000")).toEqual(
      [
        "19970905T090000",
        "19971003T090000",
        "19971107T090000",
        "19971205T090000",
        "19980102T090000",
      ],
    );
  });

  test("monthly on the second-to-last Monday", () => {
    expect(
      starts("FREQ=MONTHLY;COUNT=3;BYDAY=-2MO", "19970922T090000"),
    ).toEqual(["19970922T090000", "19971020T090000", "19971117T090000"]);
  });

  test("monthly on the last day of the month", () => {
    expect(
      starts("FREQ=MONTHLY;COUNT=4;BYMONTHDAY=-1", "19970930T090000"),
    ).toEqual([
      "19970930T090000",
      "19971031T090000",
      "19971130T090000",
      "19971231T090000",
    ]);
  });

  test("yearly in June and July", () => {
    expect(
      starts("FREQ=YEARLY;COUNT=4;BYMONTH=6,7", "19970610T090000"),
    ).toEqual([
      "19970610T090000",
      "19970710T090000",
      "19980610T090000",
      "19980710T090000",
    ]);
  });
});

describe("exdates, rdates and bounds", () => {
  test("EXDATE removes an instance without shifting the rest", () => {
    expect(
      starts("FREQ=DAILY;COUNT=4", "20260301T100000", {
        exdates: ["20260302T100000"],
      }),
    ).toEqual(["20260301T100000", "20260303T100000", "20260304T100000"]);
  });

  test("RDATE adds a date and is deduplicated against the series", () => {
    expect(
      starts("FREQ=DAILY;COUNT=2", "20260301T100000", {
        rdates: ["20260305T100000", "20260302T100000"],
      }),
    ).toEqual(["20260301T100000", "20260302T100000", "20260305T100000"]);
  });

  test("an EXDATE also suppresses a matching RDATE", () => {
    expect(
      starts("FREQ=DAILY;COUNT=1", "20260301T100000", {
        rdates: ["20260305T100000"],
        exdates: ["20260305T100000"],
      }),
    ).toEqual(["20260301T100000"]);
  });

  test("the window end stops an open-ended rule", () => {
    expect(
      starts("FREQ=DAILY", "20260301T100000", {
        windowEnd: "20260304T000000",
      }),
    ).toEqual(["20260301T100000", "20260302T100000", "20260303T100000"]);
  });

  test("keeps the last instances when maxInstances is exceeded", () => {
    const instances = starts("FREQ=DAILY;COUNT=10", "20260301T100000", {
      maxInstances: 3,
    });
    expect(instances).toEqual([
      "20260308T100000",
      "20260309T100000",
      "20260310T100000",
    ]);
  });

  test("the step guard truncates rather than spinning", () => {
    const result = expand(rule("FREQ=DAILY"), parseLocal("20260301T100000"), {
      windowEnd: parseLocal("20990101T000000"),
      maxInstances: 100_000,
      exdates: new Set(),
      rdates: [],
      maxSteps: 5,
    });
    expect(result.truncated).toBe(true);
    expect(result.instances).toHaveLength(5);
  });
});
