# Pi workstation extensions

Seven opt-in-by-installation TypeScript extensions for **Pi 1.5.2**, packaged from the supplied local extensions. No provider is required for the clock, footer, mode, reminders or Markdown export. Notification sending requires separate private configuration.

## Features

| Entry point | Behavior |
| --- | --- |
| `clock-timestamps.ts` | Durable user/assistant timestamp entries (not model context), plus a TUI footer clock; timer cleaned up on shutdown. |
| `footer.ts` | Reuses Pi's footer and moves extension statuses to the directory line, mode before clock. |
| `mode.ts` | `/ntfy pc` silences automatic notifications; `/ntfy phone` enables configured automatic events. Persists `mode.txt` and emits `app-mode:changed`. |
| `ntfy-notify.ts` | Configurable start, UI prompt, tool failure, question, completion and interruption notifications. Uses `agent_settled`, not the intermediate `agent_end`. |
| `ntfy-send.ts` | Manual `ntfy_send(title, message)` tool; independent of pc/phone mode. |
| `pi-conversation-sync.ts` | Atomic text-only Markdown exports of the raw active branch, including pre-compaction dialogue. No model calls. |
| `reminders.ts` | Markdown ideas/todos, `/remind` widget, per-section IDs, CRUD commands, `/reminders` alias and saved file selection. |

`extensions/lib/mode-state.ts` is a shared helper, **not** an entry point. `lib/ntfy.ts` shares private topic parsing and Unicode-safe title encoding. No change logger or removed agent-state extension is included.

## Installation (owner action, not performed by the preparation task)

Requires Node **22.19+** and Pi **1.5.2**. Host peer dependencies are supplied by Pi; they are neither bundled nor installed in this source tree. No build step is required; Pi loads TypeScript itself.

After reviewing the source, point Pi at this local checkout:

```sh
pi install /absolute/path/to/pi-workstation-extensions
```

That command changes Pi settings. Restart Pi or use `/reload` in an existing session. To try only one entry point for one invocation:

```sh
pi -e ./extensions/clock-timestamps.ts
```

To choose a subset persistently, use a package filter in **your private Pi settings**, merging rather than replacing existing settings:

```json
{
  "packages": [{
    "source": "/absolute/path/to/pi-workstation-extensions",
    "extensions": ["extensions/clock-timestamps.ts", "extensions/reminders.ts"]
  }]
}
```

Do not also load the same extensions as loose files. Duplicate loading can create duplicate timestamps, notification sends and commands. See [deployment](docs/deployment.md) for migration and rollback.

## Configuration and safe examples

The agent directory below means `getAgentDir()`: normally `~/.pi/agent`, overridden by Pi's `PI_CODING_AGENT_DIR`. Existing explicit configurations remain authoritative.

| Setting | Default / precedence |
| --- | --- |
| Timestamp locale | Clock defaults to `pl-PL` (preserving its original display preference); `PI_WORKSTATION_LOCALE` overrides it. Markdown export keeps its existing formatting. |
| Timestamp time zone | Host local zone; `PI_WORKSTATION_TIME_ZONE` overrides both clock and Markdown export. Use a valid IANA zone such as `UTC`. |
| Mode file | `<agent-dir>/mode.txt`; missing or invalid means `pc`. |
| Reminders file | `PI_REMINDERS_FILE`, then `<agent-dir>/reminders.path`, then `reminders.md` (legacy `reminders.txt` if md is absent). |
| Transcript directory | Existing `<agent-dir>/pi-conversation-sync/config.json` `directory`, otherwise `<agent-dir>/conversations`. |
| Notification topic file | `PI_NTFY_CONFIG`, otherwise `${XDG_CONFIG_HOME:-~/.config}/ntfy.conf`. Reads `NTFY_TOPIC=...`; missing/empty/invalid disables registration. Never executed as shell code. |
| Automatic event config | `PI_NTFY_NOTIFY_CONFIG`, otherwise `<agent-dir>/ntfy-notify.txt`. Read again for each event. Missing config disables automatic sends. |

`examples/ntfy.conf.example` contains **no topic**. Keep your real topic private; a topic is effectively a destination credential, and ntfy.sh is a third-party service. Choose your own hard-to-guess topic and keep all private files outside this checkout. Existing `~/.config/ntfy.conf` and `~/.pi/agent/ntfy-notify.txt` work unchanged with the normal agent directory/XDG defaults. Config path overrides are literal filesystem paths; use absolute paths (shell-expanded `$HOME` is fine).

Copy `examples/ntfy-notify.txt.example` to the automatic-event config path privately. Every event is disabled in the example. Set selected `enabled=true`, then `/ntfy phone`. `/ntfy pc` silences only automatic notifications: the manual tool can still send. Both send to `https://ntfy.sh/<your-topic>`; no other server or auth protocol is implemented. Titles support Unicode; title/tag header controls are rejected before sending. Topics are restricted to ASCII letters, digits, underscores and hyphens. Both senders use Fetch with literal string bodies, not curl: a leading `@` is message text, never a file reference, and curlrc has no effect. Sends time out after 10 seconds, and the manual tool limits titles to 100 and messages to 3000 JavaScript characters. HTTP/length failures are tool errors; transport failures throw and are handled by Pi.

Reminders commands:

```text
/remind
/remind new-idea Try a different terminal theme
/remind new-todo Review the extension source
/remind done t1
/remind undone t1
/remind edit i1 Updated idea
/remind remove i1
/remind file /absolute/path/to/private-reminders.md
/remind file reset
/remind help
```

IDs are numbered separately for ideas (`i1`) and todos (`t1`); a bare number is accepted only when unambiguous. No real reminders are shipped. Printed reminder entries live in session history but do not enter model context.

See [conversation export](docs/conversation-sync.md) for `/save-to-md`, event timing, filesystem safeguards and limits.

## Tests (no network)

Use an **unpacked Node installation** of Pi 1.5.2. `PI_PACKAGE_ROOT` points at its `@earendil-works/pi-coding-agent` directory (the directory with `package.json`, `dist` and `docs`), not its executable. If Pi resolves normally from Node, the variable may be omitted.

```sh
PI_PACKAGE_ROOT=/absolute/path/to/pi-coding-agent NODE_ENV=development npm test
```

Tests use Pi's native extension loader, real session fixtures and one deterministic SDK fake stream. Network APIs are blocked; notification fetches are mocked. All fixture files are under temporary directories and removed in `finally`. Tests never read the user's notification topic, reminders, credentials or session history. No dependencies, JS output or build artifacts are written into the checkout. Tests use internal loader paths, so a bundled-only executable is insufficient.

Optional strict declaration check, using already installed TypeScript and Node types:

```sh
PI_PACKAGE_ROOT=/absolute/path/to/pi-coding-agent \
PI_TYPESCRIPT_PATH=/absolute/path/to/typescript/lib/typescript.js \
PI_NODE_TYPES=/absolute/path/to/@types/node npm run test:types
```

`PI_NODE_TYPES` can be omitted if Node types resolve from Pi's host dependency tree. The `*` peer ranges follow Pi's package guidance; **only 1.5.2 is verified**, not an assertion of future API compatibility.

## Privacy, limitations and licensing

Installing extensions grants the same permissions as Pi. Conversation exports contain original user/assistant text, which can contain secrets; filtering out tools and thinking is **not redaction**. Reminders are also persisted in session custom entries. Review local exports before sharing them. Notification configuration can send local paths if you use `{cwd}`; safe examples avoid it. No notifications are sent during tests.

The footer adapts the declared read-only session API for Pi's built-in component. Its inherited approximation does not expose virtual-model routing or subscription-auth state, and the built-in footer is not a stable cross-version interface. Automatic question detection is a trailing-question-mark heuristic, not semantic classification. Reminders' mutation queue is per Pi process, not a distributed file lock.

No license has been selected or added. `private: true` prevents accidental npm publication; it does not prevent a public source repository. The owner must approve licensing and review provenance/third-party notices before publication. Existing source comments/notices are retained; this package makes no new authorship claims.
