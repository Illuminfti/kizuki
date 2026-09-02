import { test } from "bun:test";

test.todo(
  "undo-audit lane: reducer effects are limited to undo, open, filter, and quit",
  () => {
    throw new Error("pending undo-audit lane");
  },
);

test.todo(
  "undo-audit lane: no reducer path invokes a canon writer or approval action",
  () => {
    throw new Error("pending undo-audit lane");
  },
);
