---
name: documentation-accuracy
description: Write or review Kizuki documentation so every command, capability, architecture statement, limitation, link, and example matches the exact repository state and clearly separates shipped behavior from design and future vision.
---

# Documentation accuracy

1. Pin the exact revision and read code, exports, tests, manifests, RFC status, and current CLI help relevant to each claim.
2. Classify statements as implemented, accepted design, or future direction.
3. Verify commands by running them where practical; verify paths, schemas, defaults, exit behavior, and examples.
4. Never infer shipping status from an RFC, directory, TODO, registry placeholder, issue, or branch name.
5. Check internal links, anchors, Mermaid fences, code fences, package names, and version-sensitive external claims.
6. For providers, licenses, prices, quotas, SDKs, or protocols, re-check current primary sources and record limitations.
7. Use synthetic examples and never expose owner data, credentials, private infrastructure, or local paths.
8. Run the hardened repository verifier and a final claims/privacy pass.

Documentation drift is a product defect. Fix code or docs deliberately rather than wording around a contradiction.
