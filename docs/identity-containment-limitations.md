# Legacy identity containment limits

Legacy `identity_links` rows are retained for backup compatibility but are not
identity authority. Kizuki cannot infer aliases, merges, corrections, or purge
scope from them.

The service continues to return ordinary capture, claims, search, timeline,
context, and undo behavior. Context packets and doctor identify the unavailable
identity capability with `identity-authority-unavailable`.

An owner who needs identity effects must wait for a separately reviewed,
receipted migration and authority design. Re-entering old rows through import
or restore does not make them active.
