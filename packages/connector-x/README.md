# @kizuki/connector-x

Local, read-only import of owner posts from an unzipped X data archive.

This initial connector reads `data/account.js`, `data/tweets.js`, contiguous
`data/tweets-partN.js` files, and portable references in `data/tweets_media`.
It never executes archive JavaScript and never reads media bytes. Native account
and post IDs, provider timestamps, links, and supported attachment references
are preserved as connector evidence.

The package is available through the shared connector registry for
programmatic enrollment. This change does not add a command-line enrollment
route.

The connector does not inspect likes and does not support bookmarks, direct
messages, deletion inference, ZIP input, live X sync, or the paid X API. Missing
posts never produce tombstones. Health output reports this coverage explicitly.

Input is bounded to 16 MiB per tweet part, 64 MiB of selected JSON, 64 parts,
100,000 posts, 10,000 media directory entries, and 1,024 data directory entries.
Unzip larger exports into smaller independently enrolled snapshots or wait for a
future streaming importer.
