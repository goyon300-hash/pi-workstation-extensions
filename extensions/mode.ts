import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    MODES,
    MODE_CHANGED_CHANNEL,
    isAppMode,
    modeLabel,
    readMode,
    writeMode,
    type AppMode,
} from "./lib/mode-state.ts";

/**
 * Owns the shared app mode (see ./lib/mode-state.ts) and nothing else.
 *
 * Other extensions consume the mode by reading ~/.pi/agent/mode.txt or by
 * listening on the "app-mode:changed" channel; this file is the only writer.
 * The /ntfy command is just the current, user-facing way to set it.
 */
export default function (pi: ExtensionAPI) {
    let currentMode: AppMode = readMode();
    let refreshStatus: (() => void) | undefined;

    pi.registerCommand("ntfy", {
        description:
            "Set app mode for auto-notifications: /ntfy phone (send) or /ntfy pc (silent)",
        getArgumentCompletions: (prefix) =>
            MODES.filter((mode) => mode.startsWith(prefix.toLowerCase())).map(
                (mode) => ({
                    value: mode,
                    label: mode,
                    description:
                        mode === "phone"
                            ? "Send automatic notifications"
                            : "Silence automatic notifications",
                })
            ),
        handler: async (args, ctx) => {
            const value = (args ?? "").trim().toLowerCase();

            if (!isAppMode(value)) {
                if (ctx.hasUI) {
                    ctx.ui.notify(
                        `Current ${modeLabel(currentMode)}. Usage: /ntfy phone | /ntfy pc`,
                        "warning"
                    );
                }
                return;
            }

            writeMode(value);
            currentMode = value;
            refreshStatus?.();
            pi.events.emit(MODE_CHANGED_CHANNEL, value);

            if (ctx.hasUI) {
                ctx.ui.notify(`App mode set to ${modeLabel(value)}`, "info");
            }
        },
    });

    pi.on("session_start", (_event, ctx) => {
        currentMode = readMode();

        if (ctx.mode !== "tui") return;

        refreshStatus = () => {
            ctx.ui.setStatus("mode", modeLabel(currentMode));
        };

        refreshStatus();
    });

    pi.on("session_shutdown", (_event, ctx) => {
        refreshStatus = undefined;

        if (ctx.mode === "tui") {
            ctx.ui.setStatus("mode", undefined);
        }
    });
}