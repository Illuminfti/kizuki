import "./deny-websocket-preload.ts";

try {
  new WebSocket("ws://example.invalid");
} catch {
  undefined;
}
