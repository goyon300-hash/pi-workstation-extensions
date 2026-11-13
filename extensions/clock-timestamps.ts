import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "local-message-timestamp";

type TimestampData = {
    role: "user" | "assistant"; at: number;
};

const locale = process.env.PI_WORKSTATION_LOCALE || "pl-PL";
const timeZone = process.env.PI_WORKSTATION_TIME_ZONE || undefined;
const dateFormatter = new Intl.DateTimeFormat(locale, { timeZone, day: "2-digit", month: "2-digit", year: "numeric", hour:
    "2-digit", minute: "2-digit", hourCycle: "h23",
});
const clockFormatter = new Intl.DateTimeFormat(locale, { timeZone, hour: "2-digit", minute: "2-digit",
    hourCycle: "h23",
});

export default function (pi: ExtensionAPI) {
    let clockTimer: ReturnType<typeof setInterval> | undefined;

    // Timestampy pod wiadomościami
    pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
        const data = entry.data as TimestampData;
        const label = data.role === "user" ? "User" : "PI";
        const timestamp = dateFormatter.format(new Date(data.at));
        return new Text(theme.fg("dim", `${label} · ${timestamp}`), 0, 0);
    });

    // Timestamp po każdej wiadomości użytkownika
    pi.on("message_end", (event) => {
        if (event.message.role !== "user") return;
        pi.appendEntry(ENTRY_TYPE, { role: "user", at: Date.now() });
    });

    // Timestamp po każdej odpowiedzi agenta
    pi.on("turn_end", () => {
        pi.appendEntry(ENTRY_TYPE, { role: "assistant", at: Date.now() });
    });

    // Aktualny zegar w stopce TUI
    pi.on("session_start", (_event, ctx) => {
        if (ctx.mode !== "tui") return;

        if (clockTimer) clearInterval(clockTimer);

        const updateClock = () => {
            const now = clockFormatter.format(new Date());
            ctx.ui.setStatus("local-clock", now);
        };

        updateClock();
        clockTimer = setInterval(updateClock, 1000);
    });

    // Sprzątanie po zamknięciu sesji
    pi.on("session_shutdown", (_event, ctx) => {
        if (clockTimer) clearInterval(clockTimer);
        clockTimer = undefined;
        if (ctx.mode === "tui") {
            ctx.ui.setStatus("local-clock", undefined);
        }
    });
}