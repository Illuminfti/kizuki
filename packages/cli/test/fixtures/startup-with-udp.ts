import "./deny-udp-preload.ts";

void Bun.udpSocket({
  hostname: "example.invalid",
  port: 1,
  socket: {
    data() {},
    error() {},
  },
}).catch(() => undefined);
