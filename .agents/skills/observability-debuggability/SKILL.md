---
name: observability-debuggability
description: Make Kizuki behavior diagnosable through privacy-safe errors, health checks, audit receipts, structured local diagnostics, and explicit state visibility without telemetry or secret leakage.
---

# Observability and debuggability

Kizuki has no silent telemetry. Observability is local, owner-controlled, and privacy-safe.

1. Identify questions an operator must answer during failure: what happened, where, when, to which safe identifier, and what can recover it.
2. Prefer explicit health/status APIs, durable receipts, bounded local diagnostics, and stable error categories over verbose logging.
3. Correlate operations with synthetic-safe IDs, not message bodies, tokens, raw paths, or personal content.
4. Preserve causal error chains while redacting secrets and captured text.
5. Expose checkpoint freshness, derived-index freshness, migration/schema state, connection health, and recovery status where relevant.
6. Make degraded and stale states distinguishable from healthy states.
7. Test diagnostics themselves for redaction and truthful failure reporting.
8. Never add remote analytics, crash reporting, phone-home health checks, or hidden network dependencies.

Every diagnostic surface is also a data-exfiltration surface. Review it accordingly.
