/**
 * Shared app-mode state for Pi extensions.
 *
 * The app mode is one small global value — currently "pc" or "phone" — that
 * describes where you are working from. It is deliberately a plain file plus
 * a bus channel, so any extension (or external tool) can read it or react to
 * it without importing this module:
 *
 *   file:     ~/.pi/agent/mode.txt   ->  "pc" | "phone"   (missing/invalid = "pc")
 *   channel:  "app-mode:changed"     ->  emitted with the new mode on change
 *
 * `extensions/mode.ts` owns the value (command + footer status). Anything
 * else — ntfy today, something else tomorrow — just reads it. To add a mode,
 * append it to `MODES` and, if you want a pretty label, to `MODE_LABELS`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";

export const MODES = ["pc", "phone"] as const;
export type AppMode = (typeof MODES)[number];

export const DEFAULT_MODE: AppMode = "pc";

/** Kept in ~/.pi/agent/ so it sits beside the other Pi state files. */
export const MODE_FILE = join(getAgentDir(), "mode.txt");

/** pi.events channel; the payload is the new AppMode. */
export const MODE_CHANGED_CHANNEL = "app-mode:changed";

export const MODE_LABELS: Record<AppMode, string> = {
    pc: "PC",
    phone: "phone",
};

export function isAppMode(value: unknown): value is AppMode {
    return (
        typeof value === "string" &&
        (MODES as readonly string[]).includes(value)
    );
}

export function readMode(): AppMode {
    try {
        const value = readFileSync(MODE_FILE, "utf8").trim().toLowerCase();
        return isAppMode(value) ? value : DEFAULT_MODE;
    } catch {
        return DEFAULT_MODE;
    }
}

export function writeMode(mode: AppMode): void {
    mkdirSync(dirname(MODE_FILE), { recursive: true });
    writeFileSync(MODE_FILE, `${mode}\n`);
}

export function modeLabel(mode: AppMode): string {
    return `[mode: ${MODE_LABELS[mode] ?? mode}]`;
}