# Maestro coordination state

Current law is [`current-law.json`](current-law.json). It is the only
current-law pointer: RFC 0002, `docs/CURRENT.md`, and
`docs/decision-log.md`. Lanes are the table in RFC 0002 §18.4.

The Wave 1-6 epics in `tasks/tasks.jsonl` are superseded history. They
treated staging, promote, and the stranger review loop as completed
architecture and scheduled daemon/RFC absorption after incompatible
work. Do not schedule from a superseded task. Do not invent an owner
review queue or an owner-invoked promote path.

Active tasks are the RFC 0002 lanes. Each carries the same current-law
pointer. A lane is not done until its RFC exit proof runs.
