import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readTopic, titleHeader } from "./lib/ntfy.ts";

export default function (pi: ExtensionAPI) {
    const topic = readTopic();
    if (!topic) return;

    pi.registerTool({
        name: "ntfy_send",
        label: "Send phone notification",
        description:
            "Send a notification to the user's phone via ntfy. Use when the user asks to be notified, needs to make a decision, or an important task finishes or fails.",
        parameters: Type.Object({
            title: Type.String({
                description: "Short notification title",
            }),
            message: Type.String({
                description: "Notification message",
            }),
        }),

        async execute(_id, params, signal) {
            if (params.title.length > 100 || params.message.length > 3000) {
                return {
                    isError: true,
                    content: [{
                        type: "text",
                        text: "Error: title or message is too long.",
                    }],
                    details: {},
                };
            }

            const response = await fetch(`https://ntfy.sh/${topic}`, {
                method: "POST",
                headers: {
                    Title: titleHeader(params.title),
                    Priority: "3",
                    Tags: "computer",
                },
                body: params.message,
                signal: AbortSignal.any([
                    ...(signal ? [signal] : []),
                    AbortSignal.timeout(10000),
                ]),
            });

            if (!response.ok) {
                return {
                    isError: true,
                    content: [{
                        type: "text",
                        text: `ntfy failed: HTTP ${response.status}`,
                    }],
                    details: {},
                };
            }

            return {
                content: [{
                    type: "text",
                    text: "Notification successfully accepted by ntfy.",
                }],
                details: {},
            };
        },
    });
}
