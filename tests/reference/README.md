The parser regression cases in this folder come from Skill Desk 0.5.0. They are
executed against the Rust data CLI by `node --test tests/migration-parity.mjs`.
The original module import is replaced in memory; no JavaScript data provider is
used or shipped. These optional migration checks require Node.js 24+.

The Rust test suite also checks every field against 52 frozen synthetic cases in
`tests/fixtures/parser-migration.json`. Those checks run with `cargo test` and do
not require Node.js.
