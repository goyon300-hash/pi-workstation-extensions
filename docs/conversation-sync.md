# pi-conversation-sync

Text-only Markdown conversation synchronization for **Pi 1.5.2**. This document and `tests/conversation-sync.mjs` are adapted from the supplied local conversation-sync README/test, with deployment-specific paths removed and native loading retested against 1.5.2.

- Entry point: `extensions/pi-conversation-sync.ts`.
- Global configuration: `<agent-dir>/pi-conversation-sync/config.json`.
- Session/file associations: `<agent-dir>/pi-conversation-sync/sessions/<sha256-session-id>.json` (created lazily).
- Portable default destination: `<agent-dir>/conversations/`.
- An existing absolute `directory` in the global configuration takes precedence over the default and is not rewritten at startup.

The agent directory is supplied by Pi's `getAgentDir()`. No background workers, model calls, prompt injection, LLM tools or source-session modifications are added.

## Commands

```text
/save-to-md
/save-to-md dir /absolute/path containing spaces
/save-to-md dir "/absolute/path containing spaces"
/save-to-md dir '~/notes/Pi conversations'
```

The first form exports the complete current branch, including resumed history. The second changes the persistent global destination **without exporting**. An already tracked session moves on its next export; unrelated historical transcripts stay put. Naming an existing export renames it where it currently lives, without migrating it to a newly configured directory until the next full export.

## Verified API and event timing

References: installed Pi 1.5.2 `docs/extensions.md`, `docs/session-format.md`, `docs/sessions.md`, `docs/sdk.md`, `examples/extensions/session-name.ts`, extension loader, event runner and SDK tests. The native SDK regression verifies timing instead of assuming older behavior is unchanged.

- Package entry points are declared explicitly in `package.json` and compiled by Pi's native loader.
- Session storage is version-3 JSONL, with a session header and an append-only tree linked by `id`/`parentId`.
- `SessionManager.getBranch()` returns raw entries in active-branch conversation order. It does not discard pre-compaction dialogue or apply context-only edits.
- `turn_start` precedes initial user persistence. `message_end` extension handlers also run before the finalized user is appended.
- The following awaited `context` event occurs after persistence and before the provider request. The extension verifies that the pending user object exists in the raw branch, then exports that branch, **not** reconstructed event context.
- `turn_end` follows finalized assistant/tool-result persistence; `agent_settled` is the final safety boundary. Identical documents are not rewritten.
- `session_start` clears activation/pending state and never exports. New, resumed, forked and switched sessions remain untouched until new user input or explicit export.
- `session_info_changed` renames only an existing export. It reuses the already exported body rather than exporting an untouched resumed or newly selected branch.

A later extension that replaces a user message in `message_end` may prevent the object-identity activation check from matching. The manual command remains available; this composition case is not covered by the timing guarantee.

## Filesystem behavior

Only user/assistant string content and `text` blocks from raw `message` entries are included. Separate text blocks are separated by blank lines; their text is otherwise unchanged. Thinking, images, tool calls/results, custom/internal entries, summaries, system messages and metadata entries are ignored. **User/assistant text is not sanitized for secrets.**

Names and speaker timestamps use the host time zone, or `PI_WORKSTATION_TIME_ZONE` when configured. Set that variable explicitly to retain any former zone across machines. Filenames use session creation time. Frontmatter records source, session ID, creation time and `keep_archived: true`. Session names are sanitized for filenames and truncated to a byte limit, with a session-ID-derived suffix on collision.

Writes use a complete, flushed mode-0600 temporary file in the target directory, then atomic rename over an owned transcript. Initial publication uses an exclusive hard link to avoid overwriting a colliding filename. The destination filesystem must support local hard-link/rename semantics; test it privately before deployment on a network/sync mount. No live destination probes are performed by this package's tests.

Per-session tracking remembers old/new destinations during renames and directory changes. The old export is removed only after a complete replacement exists and ownership has been verified from frontmatter. Tracking is separate from Pi's source sessions. A synchronous critical section and PID lock prevent overlapping saves. Exited-writer locks can be reclaimed; malformed/empty or live-writer locks produce an error. Filesystem failures are reported without aborting the agent. Existing tracked files with missing/changed ownership frontmatter, or symlinks, are refused rather than overwritten.

## Verification

From the checkout root, with `PI_PACKAGE_ROOT` pointing at an unpacked Pi 1.5.2 package:

```sh
node tests/conversation-sync.mjs
```

The relocated suite has **18 test groups**, using temporary real Markdown/session fixtures:

1. Empty sessions produce neither Markdown nor tracking files.
2. First persisted user exports before the provider is called; transient users do not.
3. Intermediate/final assistant turns update the transcript.
4. Dialogue remains chronological and preserves Markdown.
5. Tool calls, arguments and results are excluded.
6. Thinking, images, system/custom entries and text-empty messages are excluded.
7. Resume alone does not create/update exports.
8. New input after resume exports the complete history.
9. Manual export does not modify source sessions or call a model.
10. Directory spaces, quotes, tilde expansion, persistence and lazy migration.
11. Naming renames existing exports without creating unexported ones.
12. Repeated exports retain one transcript and stable Markdown mtime.
13. Compaction retains original active-branch dialogue.
14. Tree navigation alone does nothing; subsequent export follows the active branch.
15. Reload and a separate child-process restart reuse associations.
16. Collision, unrelated-file, symlink, invalid-directory and live/exited writer protections.
17. Fork identity and injected atomic-replacement failure/recovery.
18. UTC frontmatter has an explicit `+00:00` offset (Intl labels zero offset as `GMT`).

The suite additionally loads the extension through native directory discovery and runs an actual SDK lifecycle with a deterministic fake stream: source JSONL and Markdown contain the first user at provider entry, the final answer is persisted, and the real command dispatcher and naming API work. It performs one fake stream call and no network or paid inference. All fixtures are removed afterward.

## Deliberate limits

- Existing Pi instances need `/reload` after deployment.
- Synchronous exports of exceptionally large conversations can briefly pause the UI.
- This is not a distributed/multi-host lock or a fully crash-transactional system. Abrupt termination can leave a temporary file; malformed locks require inspection rather than automatic guessing.
- External source-session changes while Pi is closed are picked up on next input/manual export, not watched continuously.
- Transcript body edits are overwritten on the next export if the ownership frontmatter still matches. Keep separate notes elsewhere.
- Do not put private transcripts, tracking files or runtime configuration in a public source checkout.
