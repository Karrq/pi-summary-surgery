# pi-summary-surgery

A [pi](https://pi.dev) extension that summarizes an explicitly marked range of the current
session on a clean-context branch, inside the same session.

`/summary` opens a picker over the active branch. Mark a start (and optionally an end) with
`tab`, press `enter`. The extension branches off the current leaf, resets the context with a
retain-none compaction that records the range, swaps in a two-tool summarizer loadout, and
sends the summarizer prompt. The summarizer reads the marked range on demand through
`section_index` / `section_read`, with none of the conversation it is summarizing in its
context.

The summary branch is durable and labeled `§summary` in `/tree`. Navigate back to where you
were whenever you like; the main branch's context and tools are untouched.

See [docs/PLAN.md](docs/PLAN.md) for the design.
