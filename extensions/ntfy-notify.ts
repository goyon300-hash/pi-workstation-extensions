import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readMode } from "./lib/mode-state.ts";
import { headerValue, readTopic, titleHeader } from "./lib/ntfy.ts";

const CONFIG_PATH = process.env.PI_NTFY_NOTIFY_CONFIG || join(getAgentDir(), "ntfy-notify.txt");

interface NotificationConfig {
    enabled: boolean;
    emoji: string;
    title: string;
    message: string;
    tags: string;
    priority: number;
}

function loadConfig(): Record<string, NotificationConfig> {
    const result: Record<string, NotificationConfig> = Object.create(null);
    let section = "";

    try {
        const content = readFileSync(CONFIG_PATH, "utf8");

        for (const rawLine of content.split(/\r?\n/)) {
            const line = rawLine.trim();

            if (!line || line.startsWith("#")) continue;

            const sectionMatch = line.match(/^\[([^\]]+)\]$/);

            if (sectionMatch) {
                section = sectionMatch[1];
                result[section] = {
                    enabled: false,
                    emoji: "",
                    title: "",
                    message: "",
                    tags: "",
                    priority: 3,
                };
                continue;
            }

            if (!section) continue;

            const separator = line.indexOf("=");
            if (separator === -1) continue;

            const key = line.slice(0, separator).trim();
            const value = line.slice(separator + 1).trim();

            const config = result[section];

            switch (key) {
                case "enabled":
                    config.enabled = value.toLowerCase() === "true";
                    break;

                case "emoji":
                    config.emoji = value;
                    break;

                case "title":
                    config.title = value;
                    break;

                case "message":
                    config.message = value;
                    break;

                case "tags":
                    config.tags = value;
                    break;

                case "priority":
                    config.priority = Math.min(
                        5,
                        Math.max(1, Number(value) || 3)
                    );
                    break;
            }
        }
    } catch {
        // Missing configuration leaves automatic notifications disabled.
    }

    return result;
}

function getText(message: any): string {
    if (!message) return "";

    if (typeof message.content === "string") {
        return message.content.trim();
    }

    if (Array.isArray(message.content)) {
        return message.content
            .filter((part: any) => part.type === "text")
            .map((part: any) => part.text ?? "")
            .join("\n")
            .trim();
    }

    return "";
}

export default function (pi: ExtensionAPI) {
    const topic = readTopic();
    if (!topic) return;

    let lastAssistantText = "";

    async function notify(
        eventName: string,
        variables: Record<string, string> = {}
    ) {
        const config = loadConfig()[eventName];

        if (!config || !config.enabled) return;

        // Auto-notifications fire only in phone mode (set with /ntfy).
        // The manual `ntfy_send` tool in ntfy-send.ts is unaffected.
        if (readMode() !== "phone") return;

        const replaceVariables = (text: string) =>
            text.replace(/\{(\w+)\}/g, (_, key) =>
                variables[key] ?? `{${key}}`
            );

        const title = replaceVariables(config.title);
        const message = replaceVariables(config.message);

        try {
            const response = await fetch(
                `https://ntfy.sh/${topic}`,
                {
                    method: "POST",
                    headers: {
    "Title": titleHeader(`${config.emoji} ${title}`.trim()),
    "Priority": String(config.priority),
    "Tags": headerValue(config.tags),
},
                    body: message,
                    signal: AbortSignal.timeout(10000),
                }
            );

            if (!response.ok) {
                console.error(
                    `NTFY: HTTP ${response.status} for ${eventName}`
                );
            }
        } catch {
            console.error(`NTFY: Failed to send ${eventName}`);
        }
    }

    // Agent starts
    pi.on("agent_start", async () => {
        lastAssistantText = "";

        await notify("agent_start", {
            cwd: process.cwd(),
        });
    });

    // Remember last assistant response
    pi.on("message_end", async (event) => {
        if (event.message?.role !== "assistant") return;

        lastAssistantText = getText(event.message);
    });

    // UI interaction required
    pi.on("ui_prompt_start", async (event, ctx) => {
        await notify("ui_prompt_start", {
            kind: event.kind ?? "unknown",
            cwd: ctx.cwd,
        });
    });

    // Tool execution errors
    pi.on("tool_execution_end", async (event, ctx) => {
        if (!event.isError) return;

        await notify("tool_error", {
            tool: event.toolName ?? "unknown",
            cwd: ctx.cwd,
        });
    });

    // Final agent state
    pi.on("agent_settled", async (event, ctx) => {
        const aborted = Boolean(event.aborted);

        if (aborted) {
            await notify("agent_interrupted", {
                cwd: ctx.cwd,
            });
        } else {
            const normalized = lastAssistantText
                .trim()
                .replace(/[\s"'”’)}\]]+$/u, "");

            const isQuestion = normalized.endsWith("?");

            if (isQuestion) {
                await notify("agent_question", {
                    cwd: ctx.cwd,
                });
            } else {
                await notify("agent_finished", {
                    cwd: ctx.cwd,
                });
            }
        }

        lastAssistantText = "";
    });
}