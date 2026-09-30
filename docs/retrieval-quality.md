# Retrieval quality

Search and context packets have to answer the way a person asks. This page says
how the deterministic floor matches a question, what it reports when it cannot,
and how the harness in `scripts/` measures both. It describes the SQLite FTS5
floor. An engine behind `kizuki.retrieval/v1` may rank differently; serving
still applies the rules under "One result per record" to whatever it nominates.

## Matching a question

1. The literal query runs first: every word must appear.
2. If the query is question-shaped and matched fewer than three records, it
   runs again on its content words. Question-shaped means three or more words
   that end in `?` or start with a question or instruction word, with no quotes
   or `*`. More than twelve distinct content terms keeps the literal form.
   Stopwords are dropped; a word of four or more letters matches by stem.
   `decide`, `decided`, `deciding` and `decision` share one content term.
3. A relaxed result must contain at least 60% of the distinct content words in
   its title or body, counted exactly. After the exact-title boost, results order
   by how many they contain, then by saturating weighted match frequency. Titles
   count four times as much as body matches, and length normalization is capped
   for long entity pages.

A relaxed answer carries `query-relaxed` in `degraded` and a `coverage` share
per hit. When nothing holds enough of the words the answer is empty and carries
`query-no-match`. The floor can be wrong in two ways worth knowing: it matches
words, not meaning, so a paraphrase that shares no vocabulary with the page
finds nothing; and a question whose few content words all appear in an unrelated
page still returns that page, at a `coverage` the caller can inspect.

## Ranking

- A canon page titled exactly the query (case and surrounding space ignored)
  ranks first.
- At close relevance, pages the loop wrote rank below pages the owner wrote:
  anything under `auto/`, the daily brief, and `rollup` pages. A machine page
  must have twice the weighted match score to outrank an owner page when
  content coverage ties, on both literal and relaxed queries.

## One result per record

- A capture that a returned canon page cites is folded into that page.
- When a source record is edited the ledger and shared index keep every live
  capture. Queries serve the newest version inside the reader's scope; a hidden
  later revision cannot withdraw a visible answer. The owner sees the newest
  version across the full scope.
- A packet with a query picks its canon pages and, within its window, its
  captures by that query. Named subjects add their other recent captures after
  the matches. Without a query the packet is the window's recent captures.

## Bounded work

Answer selection applies live canon admission, sensitivity and source policy
before counting matches and applying result limits. Ranking uses weighted match
frequency within a document and capped length normalization, rather than
corpus-wide statistics that hidden evidence could change. Vault-wide index health
is reported only to the owner.

The owner separately receives a denial sample: search examines at most 500
candidate identities for that audit and reports `scan-bound` when the sample
is capped. This can omit further denied identities; it does not cap the
authorized selection at the same ranked position. Agents receive neither the
denial sample nor its bound diagnostic.

## Measuring it

```bash
bun run eval:retrieval          # table
bun run eval:retrieval --json   # machine-readable
```

The harness builds a synthetic vault in memory: long entity pages, short
decision pages, daily digests written by the loop, and chat captures. It asks 40
questions: 12 keyword, 10 paraphrase, 8 decision and 10 unanswerable. For each
kind it reports hit@1, hit@5, hit@20, mean reciprocal rank over the top 20, and
the share of questions that returned nothing (the score that matters for
unanswerable ones). It exits 1 when a category falls under the minimum pinned in
`scripts/retrieval-quality.ts`, and `scripts/retrieval-quality.test.ts` runs the
same check in CI. The same test shows the old behavior, ANDing every word of a
question, failing those minimums.

The set is synthetic and small. A pass says ranking and question handling did
not regress on these shapes; it does not measure quality on a real vault, and
the pinned minimums are floors under the current scores, not targets.
