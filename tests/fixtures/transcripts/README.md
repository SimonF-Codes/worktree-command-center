# Transcript fixtures (Chat Panel P0)

Scrubbed captures of real Claude Code transcripts: real structure, no real content. Every one was
written by `scrub.mjs` in this folder, never by hand — read its header for exactly what it keeps.
`tests/transcript.test.ts` checks every string in every file against the scrubber's rules.

| File | What it holds | CLI version |
|---|---|---|
| `v2.1.220.jsonl` | A session's opening turns, then a turn with a prompt typed mid-turn (`queued_command`) | 2.1.220 |
| `v2.1.296.jsonl` | One turn: prompt, tool calls, replies | 2.1.296 |
| `v2.1.332.jsonl` | A session's opening turn, then a later stretch with thinking text on disk | 2.1.332 |
| `compaction.jsonl` | The turns either side of an automatic compaction | 2.1.316 |
| `clear.jsonl` | The head of the file a `/clear` started | 2.1.312 |
| `continue.jsonl` | A `--continue` resume: the `derived-from` line and the first turn after it | 2.1.329 |
| `subagent.jsonl` | A whole sub-agent file (`<session>/subagents/agent-<id>.jsonl`) | 2.1.330 |
| `subagent-parent.jsonl` | The parent session's `Agent` call and its result (a separate capture, so its ids do not match `subagent.jsonl`) | 2.1.330 |

To re-capture, pick a window by line number (0-based, end exclusive) and run:

```
node tests/fixtures/transcripts/scrub.mjs <source.jsonl> tests/fixtures/transcripts/<name>.jsonl --lines <from>:<to>
```

If it refuses to write, it found something that looks like real content. Widen the scrubber, and
never hand-edit the output.
