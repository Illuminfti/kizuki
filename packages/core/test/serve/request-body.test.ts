import { expect, test } from "bun:test";
import { HttpBodyError, readRequestText, HTTP_BODY_TIMEOUT_MS, MAX_HTTP_BODY_BYTES } from "../../src/serve/request-body";

test("body accounting accepts split UTF-8 at the byte ceiling and refuses one more byte", async () => {
  const bytes = Buffer.from('x'.repeat(MAX_HTTP_BODY_BYTES - 2) + 'é');
  function request(extra: boolean): Request {
    return new Request("http://127.0.0.1/synthetic", { method: "POST", body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, bytes.length - 1));
        for (let at = 0; at < 100; at += 1) controller.enqueue(new Uint8Array(0));
        controller.enqueue(bytes.subarray(bytes.length - 1));
        if (extra) controller.enqueue(Buffer.from('x'));
        controller.close();
      },
    }) });
  }
  expect(await readRequestText(request(false))).toBe(bytes.toString('utf8'));
  await expect(readRequestText(request(true))).rejects.toMatchObject({ status: 413 });
});

test("an interrupted body refuses without exposing the stream's error", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("synthetic-untrusted-detail")); } });
  const request = new Request("http://127.0.0.1/synthetic", { method: "POST", body: stream });
  try { await readRequestText(request); throw new Error("body admitted"); }
  catch (error) {
    expect(error).toBeInstanceOf(HttpBodyError);
    expect(String(error)).not.toContain("synthetic-untrusted-detail");
  }
});

test("a stalled body expires and cancels its reader", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Buffer.from('{"query":"')); },
    cancel() { cancelled = true; },
  });
  const request = new Request("http://127.0.0.1/synthetic", { method: "POST", body: stream });
  await expect(readRequestText(request)).rejects.toMatchObject({ status: 408 });
  expect(cancelled).toBe(true);
}, HTTP_BODY_TIMEOUT_MS + 5000);
