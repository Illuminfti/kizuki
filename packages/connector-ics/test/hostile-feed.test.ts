import { expect, test } from "bun:test";
import { makeFetcher, MAX_CALENDAR_BYTES } from "../src/fetch";

const URL = "https://example.invalid/synthetic.ics";

test("calendar feed refuses malformed UTF-8 instead of replacing captured bytes", async () => {
  const fetcher = makeFetcher(async () => new Response(Buffer.from([0xff])));
  await expect(fetcher(URL, {})).rejects.toMatchObject({ code: "parse_error" });
});

test("oversized calendar feed refuses even when stream cancellation never settles", async () => {
  let cancelled = false;
  const fetcher = makeFetcher(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(MAX_CALENDAR_BYTES + 1)); },
    cancel() { cancelled = true; return new Promise<void>(() => {}); },
  })));
  await expect(fetcher(URL, {})).rejects.toMatchObject({ code: "misconfigured" });
  expect(cancelled).toBe(true);
}, 1000);

test("calendar feed accepts split Unicode with empty chunks", async () => {
  const bytes = Buffer.from("synthetic é calendar");
  const split = bytes.indexOf(0xc3) + 1;
  const fetcher = makeFetcher(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, split));
      for (let at = 0; at < 1000; at += 1) controller.enqueue(new Uint8Array(0));
      controller.enqueue(bytes.subarray(split)); controller.close();
    },
  })));
  expect((await fetcher(URL, {})).text).toBe(bytes.toString());
});
