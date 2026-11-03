# SYNTHETIC fixtures

Every file here is **synthetic**: hand-written to the shape recorded for
`claude agents --json` on CLI 2.1.312 (docs/INTEGRATIONS.md). None is real
CLI output, none contains real session data, and passing tests against them
says nothing about compatibility with a live CLI. Ids are all-zero UUIDs,
paths use `/home/dev`, and `SYNTHETIC-SECRET-MARKER` is a canary that tests
assert never appears in an error or log line.

The live checklist in docs/INTEGRATIONS.md is what verifies the real format.
