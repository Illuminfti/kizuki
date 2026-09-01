---
name: threat-modeling
description: Threat-model a Kizuki feature or architecture before implementation by mapping assets, trust boundaries, attacker goals, abuse cases, mitigations, residual risk, and security tests. Use for auth, agents, connectors, imports, exports, filesystem, MCP, network, or sensitive-data changes.
---

# Threat modeling

1. Run `orient-repository` and read governing architecture/RFCs.
2. Define assets: owner data, canon, evidence, credentials, grants, provenance, availability, and integrity.
3. Draw data flows and trust boundaries. Treat captured content, filenames, archives, provider responses, model output, and tool arguments as hostile.
4. Enumerate attacker capabilities and abuse cases across spoofing, tampering, disclosure, privilege escalation, replay, resource exhaustion, path escape, prompt injection, and unsafe egress.
5. For each threat record precondition, exploit path, impact, existing control, proposed control, and residual risk.
6. Prefer removing authority or narrowing capability over adding detection after the fact.
7. Convert material threats into denial-path tests at public seams.
8. Re-run after architecture or trust-boundary changes.

Never treat encryption, localhost, authentication, or an LLM safety layer as a complete threat model. Security controls must preserve Kizuki's owner authority, local custody, purge, provenance, and zero-silent-egress invariants.
