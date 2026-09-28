# pi-summary-surgery

A [pi](https://pi.dev) extension that summarizes an explicitly marked range of the current
session on a clean-context branch, inside the same session.

`/summary` opens a picker over the active branch. Mark a start (and optionally an end) with
`tab`, press `enter`. The extension branches off the current leaf, resets the context with a
retain-none compaction that records the range, swaps in a two-tool summarizer loadout, and
sends the summarizer prompt. The summarizer reads the marked range on demand through
`section_index` / `section_read`, with none of the conversation it is summarizing in its
context. Ranges can span any number of earlier compactions: the tools read the raw session
tree, not the model's context.

The summary branch is durable and labeled `§summary` in `/tree`. Ask it follow-ups, then
navigate back to where you were whenever you like; the main branch's context and tools are
untouched.

## Install

```sh
pi install git:github.com/<you>/pi-summary-surgery
# or, from a local checkout, add the path to "packages" in ~/.pi/agent/settings.json
```

## Usage

```
/summary                      open the picker
/summary focus on the auth    open the picker; the words become the summary's focus
/summary start=<id> end=<id>  skip the picker (RPC / print mode); end defaults to the latest entry
```

In the picker:

| Key | Action |
|---|---|
| `tab` | mark / unmark the selected entry (max 2; a third replaces the closest) |
| `enter` | summarize: earlier mark is start, one mark runs to the latest entry, none is the whole branch |
| `?` | summarizer model and thinking level |
| `esc` | cancel |

All stock `/tree` navigation, folding, search and filter keys work as usual.

Settings live in `~/.pi/agent/summary-surgery.json`. Choosing a model switches the session to
it for the summary; switching back is left to you.

See [docs/PLAN.md](docs/PLAN.md) for the design and implementation notes.

## Development

```sh
npm install
npm run typecheck
npm test
```
