# Context packet token budgets

`context_packet` counts the complete `packet_md` using the bundled
`cl100k_base` encoding from exactly `js-tiktoken@1.0.21`. The `tokenizer` field
identifies that encoding and package version. The compatibility field
`tokens_estimate` now contains its exact encoded token count, including the
mandatory header, section headings, and any `UNCHANGED` marker. Source strings
that resemble special tokens are ordinary text. No ranks are fetched at runtime.

The accepted argument range remains 50–2,000. A request within that range can
still receive `invalid_arguments` if its mandatory header cannot fit. The error
states the numeric minimum for that header. For example, the owner/session
header with a millisecond timestamp occupies 55 tokens at budget 50; it cannot
be delivered within 50. Header fields and the self-capture marker are preserved.

Each complete candidate packet is encoded before its next piece is accepted;
packing stops at the first piece that does not fit. A retained-prefix response
uses `UNCHANGED` only when the header and marker fit; otherwise it returns the
normal full packet. A degraded response also has to fit its mandatory header.

The guarantee applies to `packet_md` under the declared encoding. It excludes
the JSON envelope and a client's prompt wrappers, and does not assert a match
to an arbitrary downstream model's tokenizer. Clients must budget those other
inputs and account for their model's encoding separately.
