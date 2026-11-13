/** Read-only Pi session -> atomic, text-only Markdown export. No model calls. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  accessSync, closeSync, constants, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const DEFAULT_DIR = join(getAgentDir(), "conversations");
const ROOT = join(getAgentDir(), "pi-conversation-sync");
const CONFIG = join(ROOT, "config.json");
const STATES = join(ROOT, "sessions");
const zone = process.env.PI_WORKSTATION_TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
const dateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset",
});
const timeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
function readOptional(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); }
  catch (error) { if (missing(error)) return; throw error; }
}
function json(path: string): any {
  const text = readOptional(path);
  return text === undefined ? undefined : JSON.parse(text);
}
function directory(): string {
  const config = json(CONFIG);
  if (config === undefined) return DEFAULT_DIR;
  if (typeof config.directory !== "string" || !isAbsolute(config.directory)) {
    throw new Error(`Invalid directory in ${CONFIG}`);
  }
  return config.directory;
}
function validateDirectory(path: string): string {
  mkdirSync(path, { recursive: true });
  const canonical = realpathSync(path);
  accessSync(canonical, constants.W_OK | constants.X_OK);
  return canonical;
}

/** Temp file is complete and flushed before replacement; never unlink the destination. */
function atomicWrite(path: string, content: string, replace = true): void {
  const temp = join(dirname(path), `.pi-conversation-sync-${randomUUID()}.tmp`);
  try {
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, content, "utf8"); fsyncSync(fd); }
    finally { closeSync(fd); }
    if (replace) renameSync(temp, path);
    else linkSync(temp, path); // Exclusive publication: a colliding session cannot be overwritten.
  } finally {
    try { unlinkSync(temp); } catch (error) { if (!missing(error)) throw error; }
  }
}
function writeJSON(path: string, value: unknown): void {
  const content = JSON.stringify(value, null, 2) + "\n";
  if (readOptional(path) !== content) atomicWrite(path, content);
}
function statePath(id: string): string {
  return join(STATES, createHash("sha256").update(id).digest("hex") + ".json");
}
function trackedPaths(id: string): string[] {
  const state = json(statePath(id));
  if (state === undefined) return [];
  if (!Array.isArray(state.paths) || !state.paths.every((p: unknown) => typeof p === "string" && isAbsolute(p))) {
    throw new Error(`Invalid transcript tracking for session ${id}`);
  }
  return state.paths;
}

/** Short synchronous critical section, also guarded against another Pi process. */
function locked<T>(id: string, action: () => T): T {
  mkdirSync(STATES, { recursive: true });
  const lock = statePath(id) + ".lock";
  let fd: number;
  try { fd = openSync(lock, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number(readOptional(lock));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Transcript lock busy: ${lock}`);
    try { process.kill(pid, 0); }
    catch (probe) {
      if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
      unlinkSync(lock); // Previous writer exited. No polling or background cleanup.
      return locked(id, action);
    }
    throw new Error(`Transcript is being saved by Pi process ${pid}; retry shortly`);
  }
  try { writeFileSync(fd, String(process.pid)); return action(); }
  finally { closeSync(fd); unlinkSync(lock); }
}

function ownedContent(path: string, id: string): string | undefined {
  try {
    if (!lstatSync(path).isFile()) throw new Error(`Refusing non-regular transcript: ${path}`);
  } catch (error) { if (missing(error)) return; throw error; }
  const content = readFileSync(path, "utf8");
  const match = /^---\nsource: pi\npi_session_id: ("[^\n]*")\n/.exec(content);
  if (!match || JSON.parse(match[1]) !== id) throw new Error(`Refusing unrelated file: ${path}`);
  return content;
}
function available(path: string, id: string): boolean {
  try { ownedContent(path, id); return true; }
  catch (error) {
    // Occupied filenames (including unrelated files and symlinks) are never replaced.
    try { lstatSync(path); return false; } catch (probe) { if (missing(probe)) throw error; throw probe; }
  }
}
function dateParts(date: Date): Record<string, string> {
  return Object.fromEntries(dateFormat.formatToParts(date).map(({ type, value }) => [type, value]));
}
function stamp(date: Date): string {
  const p = dateParts(date);
  return `${p.year}-${p.month}-${p.day}_${p.hour}-${p.minute}`;
}
function createdTime(timestamp: string): string {
  const p = dateParts(new Date(timestamp));
  const offset = p.timeZoneName === "GMT" ? "+00:00" : p.timeZoneName.replace("GMT", "");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}
function safeName(name: string): string {
  // Leave ample room for the timestamp and collision suffix under NAME_MAX (bytes).
  let result = name.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "-").replace(/[. ]+$/g, "").trim();
  while (Buffer.byteLength(result, "utf8") > 140) result = Array.from(result).slice(0, -1).join("");
  return result;
}
function filename(ctx: ExtensionContext, dir: string): string {
  const header = ctx.sessionManager.getHeader();
  if (!header) throw new Error("Session header is unavailable");
  const name = safeName(ctx.sessionManager.getSessionName() ?? "");
  const stem = stamp(new Date(header.timestamp)) + (name ? ` - ${name}` : "");
  const id = ctx.sessionManager.getSessionId();
  let path = join(dir, stem + ".md");
  if (available(path, id)) return path;
  const suffix = createHash("sha256").update(id).digest("hex").slice(0, 12);
  path = join(dir, `${stem} - ${suffix}.md`);
  for (let n = 2; !available(path, id); n++) path = join(dir, `${stem} - ${suffix}-${n}.md`);
  return path;
}
function title(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionName() ?? "Conversation";
}
function markdown(ctx: ExtensionContext): string | undefined {
  const header = ctx.sessionManager.getHeader();
  if (!header) throw new Error("Session header is unavailable");
  const dialogue: string[] = [];
  // Raw branch traversal deliberately ignores context edits and compaction boundaries.
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = typeof message.content === "string" ? message.content : message.content
      .filter((block) => block.type === "text").map((block) => block.text).join("\n\n");
    if (!text.trim()) continue;
    const when = new Date(message.timestamp ?? entry.timestamp);
    dialogue.push(`### ${message.role === "user" ? "User" : "Assistant"} · ${timeFormat.format(when)}\n\n${text}`);
  }
  if (!dialogue.length) return;
  return `---\nsource: pi\npi_session_id: ${JSON.stringify(header.id)}\ncreated: ${createdTime(header.timestamp)}\nkeep_archived: true\n---\n\n# ${title(ctx)}\n\n${dialogue.join("\n\n")}\n`;
}

/** Remember destinations before publication so a later retry can clean up an interrupted rename. */
function publish(id: string, path: string, content: string, oldPaths: string[]): string {
  const previous = ownedContent(path, id);
  for (const old of oldPaths) ownedContent(old, id); // Validate before making any changes.
  const paths = [...new Set([path, ...oldPaths])];
  writeJSON(statePath(id), { paths });
  if (previous !== content) atomicWrite(path, content, previous !== undefined);
  for (const old of paths) {
    if (old === path || ownedContent(old, id) === undefined) continue;
    unlinkSync(old); // Only after the complete replacement exists, and only verified owned files.
  }
  writeJSON(statePath(id), { paths: [path] });
  return path;
}
function save(ctx: ExtensionContext, renameOnly = false): string | undefined {
  const id = ctx.sessionManager.getSessionId();
  // Empty sessions must not even create tracking directories.
  const content = renameOnly ? undefined : markdown(ctx);
  if (!renameOnly && content === undefined) return;
  const dir = renameOnly ? undefined : validateDirectory(directory());
  if (dir) {
    const paths = trackedPaths(id);
    // Common case (including agent_settled): not even a temporary lock/state write.
    if (paths.length === 1 && filename(ctx, dir) === paths[0] && ownedContent(paths[0], id) === content) return paths[0];
  }
  return locked(id, () => {
    const oldPaths = trackedPaths(id);
    if (renameOnly) {
      const old = oldPaths.map((path) => ({ path, content: ownedContent(path, id) })).find((item) => item.content !== undefined);
      if (!old) return; // Naming an unexported session never creates a transcript.
      // Rename where it currently lives. A directory change alone does not migrate anything.
      const path = filename(ctx, dirname(old.path));
      const renamed = old.content!.replace(/^(---\n[\s\S]*?\n---\n\n)# [^\n]*\n/, (_match, frontmatter: string) => `${frontmatter}# ${title(ctx)}\n`);
      return publish(id, path, renamed, oldPaths);
    }
    return publish(id, filename(ctx, dir!), content!, oldPaths);
  });
}
function parseDirectory(raw: string): string {
  let path = raw.trim();
  if (path.startsWith('"') || path.startsWith("'")) {
    if (path.length < 2 || path.at(-1) !== path[0]) throw new Error("Unmatched directory quotes");
    path = path.slice(1, -1);
  }
  if (path === "~") path = homedir();
  else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("Use an absolute directory path (or ~/...)");
  return path;
}

export default function (pi: ExtensionAPI) {
  let activeId: string | undefined;
  let pendingUser: object | undefined;
  const report = (ctx: ExtensionContext, error: unknown) => {
    const text = `pi-conversation-sync: ${error instanceof Error ? error.message : String(error)}`;
    if (ctx.hasUI) ctx.ui.notify(text, "error"); else console.error(text);
  };
  const autoSave = (ctx: ExtensionContext) => {
    if (pendingUser && ctx.sessionManager.getBranch().some((e) => e.type === "message" && e.message === pendingUser && e.message.role === "user")) {
      activeId = ctx.sessionManager.getSessionId();
      pendingUser = undefined;
    }
    if (activeId !== ctx.sessionManager.getSessionId()) return;
    try { save(ctx); } catch (error) { report(ctx, error); }
  };
  pi.on("session_start", () => { activeId = undefined; pendingUser = undefined; });
  pi.on("message_end", (event) => {
    if (event.message.role === "user") pendingUser = event.message;
  });
  // Both turn_start and message_end precede user persistence in Pi 1.5.2.
  // context is awaited after persistence and before any provider request. Never use event.messages.
  pi.on("context", (_event, ctx) => { if (pendingUser) autoSave(ctx); });
  pi.on("turn_end", (_event, ctx) => { autoSave(ctx); });
  pi.on("agent_settled", (_event, ctx) => { autoSave(ctx); });
  pi.on("session_info_changed", (_event, ctx) => {
    try { save(ctx, true); } catch (error) { report(ctx, error); }
  });
  pi.registerCommand("save-to-md", {
    description: "Export this branch as Markdown; dir <absolute path> changes the global destination",
    handler: async (args, ctx) => {
      try {
        const input = args.trim();
        if (/^dir(?:\s|$)/.test(input)) {
          const dir = validateDirectory(parseDirectory(input.slice(3)));
          mkdirSync(ROOT, { recursive: true });
          writeJSON(CONFIG, { directory: dir });
          ctx.ui.notify(`Markdown directory: ${dir}`, "info");
        } else if (input) {
          ctx.ui.notify("Usage: /save-to-md [dir <absolute path>]", "warning");
        } else {
          const path = save(ctx);
          if (path) activeId = ctx.sessionManager.getSessionId();
          ctx.ui.notify(path ? `Saved: ${path}` : "Nothing to export: no textual conversation messages.", "info");
        }
      } catch (error) { report(ctx, error); }
    },
  });
}
