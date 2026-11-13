import {
    FooterComponent,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Custom footer layout: keep the built-in footer, but render every extension
 * status (clock, mode, …) on the right of the directory line instead of on a
 * line of its own.
 *
 * The built-in FooterComponent is reused as-is (so token stats, cost, context
 * usage and the model name stay exactly as Pi renders them); only its trailing
 * status line is relocated. Statuses are read generically from the footer data
 * provider, so any extension using ctx.ui.setStatus() lands here.
 */

/** Collapse control characters the way the built-in footer does. */
function sanitizeStatus(text: string): string {
    return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/** Put `statuses` flush right on `line`, truncating the line if it must. */
function rightAlignStatuses(
    line: string,
    statuses: string,
    width: number
): string {
    const gap = 2;
    const statusWidth = visibleWidth(statuses);

    let left = line;
    if (visibleWidth(left) + gap + statusWidth > width) {
        left = truncateToWidth(left, Math.max(0, width - statusWidth - gap), "");
    }

    const leftWidth = visibleWidth(left);
    if (leftWidth + statusWidth > width) return left;

    return left + " ".repeat(width - leftWidth - statusWidth) + statuses;
}

export default function (pi: ExtensionAPI) {
    let currentCtx: ExtensionContext | undefined;

    function install(ctx: ExtensionContext) {
        ctx.ui.setFooter((tui, _theme, footerData) => {
            const unsubscribe = footerData.onBranchChange(() =>
                tui.requestRender()
            );

            // A live, minimal AgentSession view for the built-in FooterComponent.
            // The getters read the session on every frame, so model, thinking
            // level and context usage stay current.
            const session = {
                get sessionManager() {
                    // Pi 1.5.2 FooterComponent expects getEntryCount(), but
                    // ExtensionContext exposes only the read-only session facade.
                    const manager = currentCtx!.sessionManager;
                    return {
                        getEntryCount: () => manager.getEntries().length,
                        getSessionId: () => manager.getSessionId(),
                        getLeafId: () => manager.getLeafId(),
                        getEntries: () => manager.getEntries(),
                        getCwd: () => manager.getCwd(),
                        getSessionName: () => manager.getSessionName(),
                    };
                },
                get state() {
                    return {
                        model: currentCtx?.model,
                        thinkingLevel: currentCtx?.thinkingLevel,
                    };
                },
                get model() {
                    return currentCtx?.model;
                },
                get routedModel() {
                    return undefined;
                },
                modelRuntime: { isUsingSubscription: () => false },
                getContextUsage: () => currentCtx?.getContextUsage(),
            } as unknown as ConstructorParameters<typeof FooterComponent>[0];

            const builtin = new FooterComponent(session, footerData);
            builtin.setAutoCompactEnabled(pi.getSettings().compaction?.enabled !== false);

            return {
                dispose: unsubscribe,
                invalidate() { builtin.invalidate(); },
                render(width: number): string[] {
                    if (!currentCtx) return [];

                    let lines: string[];
                    try {
                        lines = builtin.render(width);
                    } catch {
                        return [];
                    }

                    const statuses = Array.from(
                        footerData.getExtensionStatuses().entries()
                    )
                        // Reversed key order puts "mode" before "local-clock",
                        // so the clock sits furthest right.
                        .sort(([a], [b]) => b.localeCompare(a))
                        .map(([, text]) => sanitizeStatus(text))
                        .filter((text) => text.length > 0);

                    if (statuses.length === 0 || lines.length === 0) return lines;

                    lines[0] = rightAlignStatuses(
                        lines[0],
                        statuses.join("  "),
                        width
                    );

                    // Statuses moved to the directory line: drop the built-in
                    // trailing status line.
                    if (lines.length > 2) lines.length = 2;

                    return lines;
                },
            };
        });
    }

    pi.on("session_start", (_event, ctx) => {
        currentCtx = ctx;

        if (ctx.mode !== "tui") return;

        install(ctx);
    });

    pi.on("session_shutdown", (_event, ctx) => {
        currentCtx = undefined;

        if (ctx.mode === "tui") {
            ctx.ui.setFooter(undefined);
        }
    });
}