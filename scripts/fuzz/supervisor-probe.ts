// Synthetic faults for supervision tests; this process owns no durable state.
const mode = process.argv[2];
if (mode === "hang") {
  process.stdout.write('{"case":"hang-probe"}\n');
  for (;;) {}
} else if (mode === "memory") {
  const held: Buffer[] = [];
  setInterval(() => held.push(Buffer.alloc(8 * 1024 * 1024, 1)), 10);
} else if (mode === "output") {
  process.stdout.write("x".repeat(8192) + "\n");
} else if (mode === "early-exit") {
  process.stdout.write('{"case":"early-exit-probe"}\n');
} else throw new Error("unknown supervision probe");
