# Scoped typed references

Implementation in progress, authorized by the current owner's explicit request
on 2026-10-21 to complete all features and the wider roadmap. This authorization
chooses the typed-reference stage; it does not claim that the earlier draft
PD-REFS was an accepted decision or edit the historical decision log.

The compatibility boundary is the selected envelope v2 contract. Owner v1
arguments and bytes remain unchanged. V2 takes closed typed identifiers and
returns scoped identifiers, never raw generated page/source/event/claim/receipt
labels. Literal evidence remains text and never gains authority from its shape.
The existing source-field policy and redactor continue to apply below adapters.

Schema45 is reserved after the actual FCST44 migration. Existing slot refs41
is the separate known-time receipt-reference cache and remains fixed. The new
parent-table rebuild and typed target modules are being implemented before
registration; no placeholder44 migration exists.

Reference mappings are caches over retained evidence, never a second fact
store. Every resolve runs under current authority. Page refs bind a byte
snapshot, source refs are invalidated on revoke, raw subjects retain independent
exact event/source memberships, and claim groups bind2..16 exact claims. Purge
removes mappings; rebuild and restore may safely clear them. The owner v1 path
keeps its existing identifiers and mutation behavior.

No runtime or typed capability is advertised from this in-progress document.
