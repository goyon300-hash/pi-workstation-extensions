/** Private config is read, never sourced as shell code. No topic is bundled. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function readTopic(): string {
    const path = process.env.PI_NTFY_CONFIG || join(
        process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "ntfy.conf",
    );
    try {
        return readFileSync(path, "utf8").match(/^NTFY_TOPIC=([A-Za-z0-9_-]+)\s*$/m)?.[1] ?? "";
    } catch {
        return "";
    }
}

/** Reject controls rather than disguising them via title encoding. */
export function headerValue(value: string): string {
    if (/[\x00-\x1f\x7f-\x9f]/.test(value)) {
        throw new Error("ntfy header values must not contain control characters");
    }
    return value;
}

/** ntfy accepts RFC 2047 encoded titles; raw Unicode is not a Fetch ByteString. */
export function titleHeader(title: string): string {
    return `=?UTF-8?B?${Buffer.from(headerValue(title), "utf8").toString("base64")}?=`;
}
