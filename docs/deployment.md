# Deployment and rollback checklist

This is an owner-operated procedure. Packaging and tests do **not** deploy anything.

## Before replacing an existing loose-file installation

1. Review source, private configuration and existing sessions independently for secrets. Do not copy runtime data into this checkout.
2. Privately back up the seven old entry points and `lib/mode-state.ts`, plus the active agent directory's conversation-sync `config.json` and session tracking directory. Keep backups outside auto-discovered extension locations.
3. Record the **currently effective transcript destination**. If it came only from an old hardcoded default, persist that exact destination with the old extension's `/save-to-md dir <existing destination>` before upgrading. If `config.json` already has the right absolute `directory`, leave it untouched. Do not invoke the directory command with a new path just to test installation: that changes the saved destination.
4. Preserve reminders data and `reminders.path`, `mode.txt`, the private topic file and automatic notification config. Do not replace any of them with example files.
5. The clock retains its original `pl-PL` locale by default, even when the host locale is English; no launcher/shell edit is needed to preserve Polish date formatting. `PI_WORKSTATION_LOCALE` remains an optional explicit override. Clock/export time zones still default to the host zone; if that differs from the prior fixed zone, use `PI_WORKSTATION_TIME_ZONE` to retain it. This locale compatibility change does not change transcript destination or timestamp-zone behavior. Leave the same `PI_CODING_AGENT_DIR` and XDG configuration paths in effect.

## Install once

Choose **one** method:

- **Package:** register the reviewed checkout using `pi install /absolute/path/to/checkout`, remove/disable only the matching old loose-file entry points, and restart/reload Pi. Preserve unrelated extensions. Keep helpers with their entry points, but do not configure `lib/*.ts` as entry points.
- **Loose-file replacement:** replace the corresponding seven files and `lib/mode-state.ts`, and add the required new `lib/ntfy.ts` helper alongside them. Do not also register the package. Do not copy tests/examples/runtime files into the live extension directory.

The package's `pi.extensions` list intentionally excludes helper modules and the change logger. Do not delete an existing change logger or unrelated extension as part of this migration.

Run `/reload` in each existing Pi instance or restart it. Confirm no duplicate `/ntfy`, `/remind`, `/save-to-md` commands or duplicated timestamp blocks appear. A second custom footer can replace this footer; choose only the desired one.

## Private smoke checks

- Check the clock and mode footer in TUI; `/ntfy pc` should be silent.
- Inspect `/remind file` without changing it. Confirm the selected file is unchanged. Avoid printing private reminders into a shared session.
- Confirm conversation `config.json` still names the original destination. Resuming/reloading alone must not export. Use a deliberately non-sensitive session for `/save-to-md` and a name change; verify the destination before checking the file.
- Keep notifications disabled until the topic/config is independently reviewed. If authorized, send one clearly labeled manual test; automated tests in this repository never send one.
- Verify target filesystem hard-link and atomic-rename support using disposable private fixtures if not already known. Do not test overwriting real transcripts.

## Rollback

Disable the package or remove the newly installed loose-file entry points; restore the reviewed private backup of the old source layout, including its shared helper. Restart/reload all affected Pi instances. Restore runtime config only if it changed; a normal upgrade need not modify it. Do not delete transcript/tracking/reminder files as a rollback step. The config/tracking formats are unchanged, so a source rollback does not require migrating those files.
