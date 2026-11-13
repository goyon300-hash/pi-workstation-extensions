# Changelog / feature inventory

## [0.1.0]

Initial source-only packaging of the supplied local workstation extensions. This is not a claim about the originals' creation date or authorship.

### Included

- Clock/timestamp session entries and a session-scoped TUI timer.
- Built-in-footer layout adapter, shared pc/phone mode command and event channel.
- Configurable ntfy lifecycle notifications and the manual `ntfy_send` tool.
- Atomic, owned-file-only Markdown conversation synchronization and persistent destination/session associations.
- Markdown reminders CRUD, per-section IDs, completion, transcript renderer and toggleable widget.
- Explicit seven-entry Pi manifest, host peer dependencies only, disabled/synthetic examples, deployment/rollback instructions and no-network loader/behavior/SDK tests.

### Portability and compatibility

- Checked against Pi 1.5.2 native loader, declarations and SDK. Legacy `@mariozechner/*` imports are supported by Pi; switching these sources to current `@earendil-works/*` names is maintenance, not a demonstrated legacy import failure.
- Personal hardcoded transcript destination replaced by `<agent-dir>/conversations`; existing explicit destination JSON remains authoritative and unchanged.
- Mode and automatic notification paths follow `getAgentDir()`; legacy default paths still apply under the normal agent directory. Private topic configuration supports XDG and explicit path overrides.
- Clock preserves its original `pl-PL` locale by default, with `PI_WORKSTATION_LOCALE` override; regression covers an English-locale host. Clock/export time zones still default to the host zone with `PI_WORKSTATION_TIME_ZONE` override. Transcript destination/zone compatibility is unchanged.
- Footer adapter uses only the declared read-only session methods to supply the built-in component's entry count, and honors the compaction-enabled setting. The live runner currently supplies the full manager, so this is public-contract hardening, not a claim of a reproduced live blank-footer bug.

### Correctness fixes

- Unicode notification titles use encoded headers rather than an invalid raw Unicode header or unmarked base64. Manual sends tolerate an absent tool cancellation signal.
- Manual length/HTTP failures return `isError: true`; transport failures continue to throw for Pi to handle.
- Reject title/tag header control characters before sending. Tests cover unsafe topic rejection and literal leading-`@` bodies; these Fetch-based senders never execute curl or read curlrc.
- Tool-error notifications use the documented `tool_execution_end.isError` field, removing a nonexistent event property from strict type checking.
- Missing private notification config disables sends quietly; error logs do not include request URLs/config payloads. Config sections use a null-prototype map.
- Mode is updated in memory only after its file write succeeds. Mode/reminder path-selection writes create the parent agent directory when necessary.
- UTC transcript frontmatter retains an explicit `+00:00` offset instead of losing its zone when Intl returns `GMT`.
- Transcript frontmatter adds `keep_archived: true` after `created`; ownership checks still match the leading `source`/`pi_session_id` lines.
- Conversation-sync tests resolve their relocated extension/host installation rather than hardcoding an old live path or release number. Network operations are blocked or mocked.

No live deployment, license selection, Git initialization or publication is performed by this package preparation.
