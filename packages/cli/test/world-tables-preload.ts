import { registerWorldTableSpecs } from "@kizuki/core/testing";

/** Synthetic derived and cache world tables for CLI processes under test. */
registerWorldTableSpecs([
  {
    name: "world_synth_summary",
    class: "derived",
    since: 33,
    columns: ["subject", "summary"],
    erasure: { via: "none", reason: "rebuilt from authority" },
    create: (db) => db.exec("CREATE TABLE IF NOT EXISTS world_synth_summary(subject TEXT PRIMARY KEY, summary TEXT NOT NULL) STRICT"),
  },
  {
    name: "world_synth_slots",
    class: "cache",
    since: 33,
    columns: ["slot", "token"],
    erasure: { via: "none", reason: "runtime cache" },
    create: (db) => db.exec("CREATE TABLE IF NOT EXISTS world_synth_slots(slot INTEGER PRIMARY KEY, token TEXT) STRICT"),
    reset: (db) => {
      db.exec("CREATE TABLE IF NOT EXISTS world_synth_slots(slot INTEGER PRIMARY KEY, token TEXT) STRICT");
      db.exec("DELETE FROM world_synth_slots");
      db.exec("INSERT INTO world_synth_slots(slot,token) VALUES (0,NULL)");
    },
  },
]);
