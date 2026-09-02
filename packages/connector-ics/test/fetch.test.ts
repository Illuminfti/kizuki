import { describe, expect, test } from "bun:test";
import { KizukiError } from "@kizuki/core";
import type { KizukiErrorCode } from "@kizuki/core";
import { ACCEPT, MAX_CALENDAR_BYTES, makeFetcher } from "../src/fetch";
import type { FetchLike } from "../src/fetch";

const URL_UNDER_TEST = "https://calendar.acme.example/private/abc123.ics";

/** Every message reachable from a thrown error, causes included. */
function chain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    parts.push(current.message, String(current.stack ?? ""));
    current = current.cause;
  }
  parts.push(String(current));
  return parts.join("\n");
}

interface Call {
  url: string;
  headers: Record<string, string>;
  hasTimeout: boolean;
  redirect: string | undefined;
}

function stub(handler: (url: string, call: Call) => Response): {
  fetchImpl: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (init.headers ?? {}) as Record<string, string>,
    )) {
      headers[key] = value;
    }
    const call: Call = {
      url,
      headers,
      hasTimeout: init.signal instanceof AbortSignal,
      redirect: init.redirect,
    };
    calls.push(call);
    return handler(url, call);
  };
  return { fetchImpl, calls };
}

const calendarBody = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";

describe("the calendar fetcher", () => {
  test("sends the accept header, a timeout and manual redirects", async () => {
    const { fetchImpl, calls } = stub(
      () => new Response(calendarBody, { status: 200 }),
    );
    const result = await makeFetcher(fetchImpl)(URL_UNDER_TEST, {});
    expect(result.status).toBe(200);
    expect(result.text).toBe(calendarBody);
    expect(calls[0]?.headers["Accept"]).toBe(ACCEPT);
    expect(calls[0]?.hasTimeout).toBe(true);
    expect(calls[0]?.redirect).toBe("manual");
  });

  test("refuses a non-https URL before any request", async () => {
    const { fetchImpl, calls } = stub(() => new Response("", { status: 200 }));
    await expect(
      makeFetcher(fetchImpl)("http://calendar.acme.example/a.ics", {}),
    ).rejects.toThrow(/only https/);
    expect(calls).toEqual([]);
  });

  test("follows up to three https redirects", async () => {
    const { fetchImpl, calls } = stub((url) => {
      const hop = Number(/hop(\d)/.exec(url)?.[1] ?? "0");
      if (hop < 3) {
        return new Response("", {
          status: 302,
          headers: { location: `https://calendar.acme.example/hop${hop + 1}` },
        });
      }
      return new Response(calendarBody, { status: 200 });
    });
    const result = await makeFetcher(fetchImpl)(
      "https://calendar.acme.example/hop0",
      {},
    );
    expect(result.status).toBe(200);
    expect(calls).toHaveLength(4);
  });

  test("refuses a fourth redirect", async () => {
    const { fetchImpl } = stub(
      () =>
        new Response("", {
          status: 302,
          headers: { location: "https://calendar.acme.example/again" },
        }),
    );
    await expect(makeFetcher(fetchImpl)(URL_UNDER_TEST, {})).rejects.toThrow(
      /too many redirects/,
    );
  });

  test("refuses a redirect that leaves https", async () => {
    const { fetchImpl } = stub(
      () =>
        new Response("", {
          status: 302,
          headers: { location: "http://calendar.acme.example/plain" },
        }),
    );
    await expect(makeFetcher(fetchImpl)(URL_UNDER_TEST, {})).rejects.toThrow(
      /only https/,
    );
  });

  test("round-trips the conditional headers and reports 304", async () => {
    const { fetchImpl, calls } = stub(
      () =>
        new Response(null, {
          status: 304,
          headers: {
            etag: '"v2"',
            "last-modified": "Mon, 02 Mar 2026 09:00:00 GMT",
          },
        }),
    );
    const result = await makeFetcher(fetchImpl)(URL_UNDER_TEST, {
      etag: '"v1"',
      last_modified: "Sun, 01 Mar 2026 09:00:00 GMT",
    });
    expect(calls[0]?.headers["If-None-Match"]).toBe('"v1"');
    expect(calls[0]?.headers["If-Modified-Since"]).toBe(
      "Sun, 01 Mar 2026 09:00:00 GMT",
    );
    expect(result).toEqual({
      status: 304,
      etag: '"v2"',
      last_modified: "Mon, 02 Mar 2026 09:00:00 GMT",
      text: "",
    });
  });

  test("aborts a body past the size cap", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const { fetchImpl } = stub(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(chunk);
            },
          }),
          { status: 200 },
        ),
    );
    await expect(makeFetcher(fetchImpl)(URL_UNDER_TEST, {})).rejects.toThrow(
      /exceeds 16 MiB/,
    );
    expect(MAX_CALENDAR_BYTES).toBe(16 * 1024 * 1024);
  });

  test.each<[number, KizukiErrorCode]>([
    [401, "unauthenticated"],
    [403, "unauthenticated"],
    [404, "misconfigured"],
    [410, "misconfigured"],
    [429, "rate_limited"],
    [500, "unreachable"],
    [503, "unreachable"],
  ])("maps status %s", async (status, code) => {
    const { fetchImpl } = stub(() => new Response("", { status }));
    const error = await makeFetcher(fetchImpl)(URL_UNDER_TEST, {}).catch(
      (caught: unknown) => caught,
    );
    expect((error as KizukiError).code).toBe(code);
  });

  test("a transport failure is unreachable", async () => {
    const { fetchImpl } = stub(() => {
      throw new Error("socket hang up");
    });
    const error = await makeFetcher(fetchImpl)(URL_UNDER_TEST, {}).catch(
      (caught: unknown) => caught,
    );
    expect((error as KizukiError).code).toBe("unreachable");
  });

  test("no error message ever names the calendar URL", async () => {
    const messages: string[] = [];
    for (const status of [401, 404, 429, 500]) {
      const { fetchImpl } = stub(() => new Response("", { status }));
      const error = await makeFetcher(fetchImpl)(URL_UNDER_TEST, {}).catch(
        (caught: unknown) => caught,
      );
      messages.push((error as KizukiError).message);
    }
    for (const message of messages) {
      expect(message).not.toContain("abc123");
      expect(message).not.toContain("calendar.acme.example");
    }
  });

  test("a body that fails mid-stream is typed and says nothing", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("BEGIN:VCALENDAR\r\n"));
            controller.error(new Error(`stream failed for ${URL_UNDER_TEST}`));
          },
        }),
        { status: 200 },
      );
    const error = await makeFetcher(fetchImpl)(URL_UNDER_TEST, {}).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(KizukiError);
    expect((error as KizukiError).code).toBe("unreachable");
    expect(chain(error)).not.toContain("abc123");
    expect(chain(error)).not.toContain("calendar.acme.example");
  });

  test("a transport failure keeps the URL out of its cause chain", async () => {
    const { fetchImpl } = stub(() => {
      throw new Error(`connect ECONNREFUSED ${URL_UNDER_TEST}`);
    });
    const error = await makeFetcher(fetchImpl)(URL_UNDER_TEST, {}).catch(
      (caught: unknown) => caught,
    );
    expect((error as KizukiError).code).toBe("unreachable");
    expect(chain(error)).not.toContain("abc123");
    expect(chain(error)).not.toContain("calendar.acme.example");
  });
});
