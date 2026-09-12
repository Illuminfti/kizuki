import "./deny-socket-preload.ts";

void Bun.connect({
  hostname: "example.invalid",
  port: 1,
  socket: {
    data() {},
    error() {},
    open() {},
    close() {},
  },
}).catch(() => undefined);
