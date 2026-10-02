# Private ChatGPT tunnel

Read [the setup, authority limits and acceptance runbook](../../docs/chatgpt.md)
before provisioning anything. These Linux operator scripts wrap the existing
scoped stdio MCP adapter. They add no public listener or OAuth server.

`run-tunnel.sh check` performs local configuration checks; `doctor` and `run`
explicitly invoke the operator-installed OpenAI tunnel client. Neither setup
templates nor the skills-only plugin establish a registered ChatGPT connection.
