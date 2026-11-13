/**
 * Reminders — ideas & todos for Pi
 *
 * A small extension that keeps a plain-text ideas/todo list in a Markdown file
 * you can edit by hand. A session start prints the list into the transcript
 * once (like `/session`), and `/remind` toggles a widget above the editor.
 *
 * Data file:  ~/.pi/agent/reminders.md    (override with PI_REMINDERS_FILE)
 *
 * Format (any Markdown is fine — only list items and section headings matter):
 *
 *   ## Ideas
 *   - a thought worth keeping
 *
 *   ## Todos
 *   - [ ] something to do
 *   - [x] something already done
 *
 * Lines without a heading are guessed: `- [ ] ...` becomes a todo, a plain
 * `- ...` becomes an idea. Remove or edit items by editing the file directly.
 *
 * Commands:
 *   /remind                     toggle the list widget
 *   /remind new-idea <text>     add an idea
 *   /remind new-todo <text>     add a todo
 *   /remind done <id>           mark a todo done
 *   /remind undone <id>         mark a todo not done
 *   /remind remove <id>         delete an item
 *   /remind edit <id> <text>    replace an item's text
 *   /remind file [path]         show or set the reminders file
 *   /remind file reset          go back to the default file
 *   /remind help                show usage
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type Theme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const TEMPLATE = `# Ideas & Todos

<!-- Edit this file by hand at any time.
     Under "## Ideas" use "- text" for an idea.
     Under "## Todos" use "- [ ] text" for open, "- [x] text" for done.
     Run /remind to reload the list. -->

## Ideas

## Todos

`;

type Section = "idea" | "todo";

/** The part of an item that is stored in the transcript entry. */
interface ItemData {
	id: number;
	section: Section;
	text: string;
	done: boolean;
}

interface Item extends ItemData {
	/** Index into the raw file line array (used for in-place edits). */
	lineIndex: number;
}

interface RemindersEntry {
	items: ItemData[];
	timestamp: number;
}

// ---------------------------------------------------------------------------
// File handling
// ---------------------------------------------------------------------------

/** Expand `~` and resolve relative paths against the current directory. */
function expandPath(path: string): string {
	const expanded = path.replace(/^~(?=$|[/\\])/, homedir());
	return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

/** Where the chosen file path is remembered between sessions. */
function configFile(): string {
	return join(getAgentDir(), "reminders.path");
}

/** The path saved with `/remind file`, if any. */
function savedPath(): string | null {
	try {
		const value = readFileSync(configFile(), "utf8").trim();
		return value || null;
	} catch {
		return null;
	}
}

/** Resolve the data file: env override, then saved path, then the default. */
function resolveFile(): string {
	const override = process.env.PI_REMINDERS_FILE?.trim();
	if (override) return expandPath(override);

	const saved = savedPath();
	if (saved) return saved;

	const dir = getAgentDir();
	const md = join(dir, "reminders.md");
	const txt = join(dir, "reminders.txt");
	if (!existsSync(md) && existsSync(txt)) return txt;
	return md;
}

/** Point the extension at a file, creating it from the template if needed. */
function setFile(path: string): string {
	const target = expandPath(path);
	if (existsSync(target) && statSync(target).isDirectory()) {
		throw new Error(`${target} is a directory, not a file`);
	}
	mkdirSync(dirname(target), { recursive: true });
	if (!existsSync(target)) writeFileSync(target, TEMPLATE, "utf8");
	mkdirSync(dirname(configFile()), { recursive: true });
	writeFileSync(configFile(), `${target}\n`, "utf8");
	return target;
}

/** Forget the saved path and fall back to the default file. */
function resetFile(): void {
	rmSync(configFile(), { force: true });
}

/** Create the data file from the template when it does not exist yet. */
function ensureFile(): string {
	const file = resolveFile();
	if (!existsSync(file)) {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, TEMPLATE, "utf8");
	}
	return file;
}

function readText(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

/**
 * Read-modify-write the data file under Pi's file mutation queue so concurrent
 * edits from the agent or another extension cannot clobber each other.
 */
async function mutate<T>(fn: (lines: string[]) => T): Promise<T> {
	const file = ensureFile();
	return withFileMutationQueue(file, async () => {
		const lines = (existsSync(file) ? readFileSync(file, "utf8") : TEMPLATE).split(/\r?\n/);
		const result = fn(lines);
		while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
		writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
		return result;
	});
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function sectionOfHeader(line: string): Section | null {
	const match = line.trim().match(/^#{1,6}\s+(.*)$/);
	if (!match) return null;
	const title = match[1].toLowerCase();
	const isIdea = /(idea|thought|灵感|想法)/.test(title);
	const isTodo = /(to-?do|task|待办|任务)/.test(title);
	// A title that mentions both (e.g. "# Ideas & Todos") is the document
	// heading, not a section.
	if (isIdea === isTodo) return null;
	return isIdea ? "idea" : "todo";
}

function parseLines(lines: string[]): Item[] {
	const items: Item[] = [];
	let section: Section | null = null;
	let seenHeading = false;
	// Items under a heading we don't recognise (other than the document title)
	// are ignored, so unrelated lists don't leak into ideas/todos. Items in a
	// flat file with no headings fall back to checkbox guessing.
	let ignoreRegion = false;
	// Ideas and todos are numbered independently (1, 2, … each).
	let ideaId = 0;
	let todoId = 0;

	lines.forEach((raw, lineIndex) => {
		const trimmed = raw.trim();
		const headerSection = sectionOfHeader(raw);
		if (headerSection) {
			section = headerSection;
			seenHeading = true;
			ignoreRegion = false;
			return;
		}
		if (/^#{1,6}\s/.test(trimmed)) {
			// The first unrecognised heading is the document title; later ones
			// start a region whose list items we do not claim.
			ignoreRegion = seenHeading;
			seenHeading = true;
			section = null;
			return;
		}

		const bullet = trimmed.match(/^[-*+]\s+(.*)$/);
		if (!bullet) return;

		let text = bullet[1].trim();
		let done = false;
		const checkbox = text.match(/^\[([ xX])\]\s*(.*)$/);
		if (checkbox) {
			done = checkbox[1].toLowerCase() === "x";
			text = checkbox[2].trim();
		}
		if (!text) return;

		const itemSection = section ?? (ignoreRegion ? null : checkbox ? "todo" : "idea");
		if (!itemSection) return;

		items.push({
			id: itemSection === "idea" ? ++ideaId : ++todoId,
			section: itemSection,
			text,
			done,
			lineIndex,
		});
	});

	return items;
}

function readItems(): Item[] {
	return parseLines(readText(ensureFile()).split(/\r?\n/));
}

/** Strip the file-only fields so the entry data stays small and portable. */
function toData(items: Item[]): ItemData[] {
	return items.map(({ id, section, text, done }) => ({ id, section, text, done }));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function counts(items: ItemData[]): string {
	const ideas = items.filter((i) => i.section === "idea").length;
	const todos = items.filter((i) => i.section === "todo");
	const done = todos.filter((t) => t.done).length;
	const ideaLabel = `${ideas} ${ideas === 1 ? "idea" : "ideas"}`;
	const todoLabel = todos.length ? `${todos.length} todos (${done} done)` : "0 todos";
	return `${ideaLabel} · ${todoLabel}`;
}

/**
 * The themed list drawn in the transcript and in the widget.
 *
 * Long item text is wrapped with a hanging indent so continuation lines line
 * up under the item text rather than under the bullet.
 */
class RemindersView implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly items: ItemData[],
		private readonly timestamp: number,
		private readonly expanded: boolean,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const leftPad = 1;
		const contentWidth = Math.max(1, width - leftPad);
		const lines: string[] = [];
		const push = (line: string) => lines.push(truncateToWidth(" ".repeat(leftPad) + line, width));

		push(`${th.fg("accent", th.bold("Reminders"))}${th.fg("dim", `  ${counts(this.items)}`)}`);

		if (this.items.length === 0) {
			lines.push("");
			push(th.fg("dim", "No ideas or todos yet."));
			push(th.fg("dim", "Add one with /remind new-idea <text> or /remind new-todo <text>."));
			return this.cache(width, lines);
		}

		lines.push("");
		let lastSection: Section | null = null;
		for (const item of this.items) {
			if (item.section !== lastSection) {
				if (lastSection !== null) lines.push("");
				push(th.fg("muted", item.section === "idea" ? "Ideas" : "Todos"));
				lastSection = item.section;
			}

			const id = th.fg("accent", `${item.id}.`);
			const mark =
				item.section === "todo"
					? item.done
						? th.fg("success", "✓")
						: th.fg("dim", "○")
					: th.fg("muted", "•");
			const prefix = `  ${id} ${mark} `;
			const prefixWidth = visibleWidth(prefix);
			const text = item.done ? th.fg("dim", item.text) : th.fg("text", item.text);
			const wrapped = wrapTextWithAnsi(text, Math.max(1, contentWidth - prefixWidth));
			const indent = " ".repeat(prefixWidth);

			wrapped.forEach((line, index) => {
				push(index === 0 ? prefix + line : indent + line);
			});
		}

		if (this.expanded) {
			lines.push("");
			push(th.fg("dim", new Date(this.timestamp).toLocaleString()));
		}

		return this.cache(width, lines);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private cache(width: number, lines: string[]): string[] {
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

/** A short, plain-text rendering used outside the interactive TUI. */
function plainText(items: ItemData[]): string {
	if (items.length === 0) return "No ideas or todos yet.";
	const lines: string[] = [];
	let lastSection: Section | null = null;
	for (const item of items) {
		if (item.section !== lastSection) {
			lines.push(item.section === "idea" ? "Ideas:" : "Todos:");
			lastSection = item.section;
		}
		const mark = item.section === "todo" ? (item.done ? "[x]" : "[ ]") : "•";
		lines.push(`  ${item.id}. ${mark} ${item.text}`);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

type Action = "add-idea" | "add-todo" | "done" | "undone" | "remove" | "edit";

/** A reference to an item: `t2` / `i2`, or a bare `2` when unambiguous. */
interface ItemRef {
	section?: Section;
	id: number;
}

const SECTION_PREFIX: Record<string, Section> = {
	i: "idea",
	idea: "idea",
	t: "todo",
	todo: "todo",
	td: "todo",
	task: "todo",
};

function parseRef(token: string): ItemRef | null {
	const match = token.trim().match(/^([a-zA-Z]*)(\d+)$/);
	if (!match) return null;
	const id = Number.parseInt(match[2], 10);
	if (!Number.isFinite(id)) return null;
	const prefix = match[1].toLowerCase();
	if (prefix === "") return { id };
	const section = SECTION_PREFIX[prefix];
	return section ? { section, id } : null;
}

function refLabel(ref: ItemRef): string {
	const prefix = ref.section === "idea" ? "i" : ref.section === "todo" ? "t" : "";
	return `${prefix}${ref.id}`;
}

const SUBCOMMANDS: Array<{ value: string; description: string }> = [
	{ value: "new-idea", description: "Add an idea" },
	{ value: "new-todo", description: "Add a todo" },
	{ value: "done", description: "Mark a todo done" },
	{ value: "undone", description: "Mark a todo not done" },
	{ value: "remove", description: "Delete an item by id" },
	{ value: "edit", description: "Replace an item's text" },
	{ value: "file", description: "Show or set the reminders file" },
	{ value: "list", description: "Show the list" },
	{ value: "help", description: "Show usage" },
];

const USAGE = [
	"/remind                     toggle the list widget",
	"/remind new-idea <text>     add an idea",
	"/remind new-todo <text>     add a todo",
	"/remind done <id>           mark a todo done",
	"/remind undone <id>         mark a todo not done",
	"/remind remove <id>         delete an item",
	"/remind edit <id> <text>    replace an item's text",
	"/remind file [path]         show or set the reminders file",
	"/remind file reset          go back to the default file",
	"/remind help                show this help",
	"",
	"Ids are per-section: ideas are i1, i2, … and todos are t1, t2, …",
	"(a bare number works when it is unambiguous).",
].join("\n");

/** Insert a new item right after the last item of its section. */
function insertItem(lines: string[], section: Section, text: string): void {
	const itemLine = section === "todo" ? `- [ ] ${text}` : `- ${text}`;

	const headerIndex = lines.findIndex((line) => sectionOfHeader(line) === section);
	if (headerIndex === -1) {
		if (lines.length > 0 && lines[lines.length - 1].trim() !== "") lines.push("");
		lines.push(section === "todo" ? "## Todos" : "## Ideas", "", itemLine);
		return;
	}

	let sectionEnd = lines.length;
	for (let i = headerIndex + 1; i < lines.length; i++) {
		if (/^#{1,6}\s/.test(lines[i].trim())) {
			sectionEnd = i;
			break;
		}
	}

	let insertAt = headerIndex + 1;
	for (let i = headerIndex + 1; i < sectionEnd; i++) {
		if (lines[i].trim() !== "") insertAt = i + 1;
	}
	lines.splice(insertAt, 0, itemLine);
}

async function applyAction(action: Action, ref: ItemRef | undefined, text: string): Promise<string> {
	return mutate((lines) => {
		const items = parseLines(lines);

		if (action === "add-idea" || action === "add-todo") {
			const section: Section = action === "add-idea" ? "idea" : "todo";
			insertItem(lines, section, text);
			return `Added ${section}: ${text}`;
		}

		if (!ref) throw new Error("an item id is required");

		const matches = items.filter((i) => i.id === ref.id && (!ref.section || i.section === ref.section));
		if (matches.length === 0) throw new Error(`no item ${refLabel(ref)}`);
		if (matches.length > 1) {
			throw new Error(`#${ref.id} exists in both ideas and todos — use i${ref.id} or t${ref.id}`);
		}
		const item = matches[0];
		const id = refLabel({ section: item.section, id: item.id });

		switch (action) {
			case "done":
			case "undone": {
				const hasCheckbox = /\[[ xX]\]/.test(lines[item.lineIndex]);
				if (item.section !== "todo" && !hasCheckbox) {
					throw new Error(`#${id} is an idea, not a todo (use /remind edit or remove)`);
				}
				const done = action === "done";
				const match = lines[item.lineIndex].match(/^(\s*[-*+]\s+)(?:\[[ xX]\]\s+)?(.*)$/);
				lines[item.lineIndex] = `${match ? match[1] : "- "}[${done ? "x" : " "}] ${match ? match[2] : item.text}`;
				return `#${id} marked ${done ? "done" : "not done"}`;
			}
			case "remove": {
				lines.splice(item.lineIndex, 1);
				return `Removed #${id}: ${item.text}`;
			}
			case "edit": {
				if (!text) throw new Error("new text is required for edit");
				const match = lines[item.lineIndex].match(/^(\s*[-*+]\s+(?:\[[ xX]\]\s+)?)(.*)$/);
				lines[item.lineIndex] = `${match ? match[1] : "- "}${text}`;
				return `#${id} updated`;
			}
		}
	});
}

export default function (pi: ExtensionAPI) {
	// Draw the printed list in the transcript. Custom entries live in the
	// session (and HTML exports) but are never sent to the model.
	pi.registerEntryRenderer<RemindersEntry>("reminders", (entry, { expanded }, theme) => {
		const data = entry.data ?? { items: [], timestamp: Date.now() };
		return new RemindersView(data.items, data.timestamp, expanded, theme);
	});

	/** True when the current branch already holds a reminders block.
	 * /resume and /reload re-fire session_start; skip reprinting so only one
	 * block ever appears per session. */
	function hasRemindersEntry(ctx: ExtensionContext): boolean {
		try {
			return ctx.sessionManager.getBranch().some((e) => e.type === "custom" && e.customType === "reminders");
		} catch {
			return false;
		}
	}

	/** Print the current list into the transcript (falls back to a notification). */
	function printList(ctx: ExtensionContext): void {
		const items = toData(readItems());
		if (ctx.mode === "tui") {
			pi.appendEntry<RemindersEntry>("reminders", { items, timestamp: Date.now() });
		} else if (ctx.hasUI) {
			ctx.ui.notify(plainText(items), "info");
		}
	}

	/** One-line feedback for an action. */
	function notifyState(ctx: ExtensionContext, note: string): void {
		if (ctx.hasUI) ctx.ui.notify(note, "info");
	}

	// The widget shown by `/remind` lives above the editor for the rest of the
	// session; it is refreshed whenever the list changes.
	const WIDGET_KEY = "reminders";
	let widgetVisible = false;

	function refreshWidget(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		const items = toData(readItems());
		ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => new RemindersView(items, Date.now(), false, theme));
	}

	function showWidget(ctx: ExtensionContext): void {
		widgetVisible = true;
		refreshWidget(ctx);
	}

	function hideWidget(ctx: ExtensionContext): void {
		widgetVisible = false;
		if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	function toggleWidget(ctx: ExtensionContext): void {
		if (widgetVisible) hideWidget(ctx);
		else showWidget(ctx);
	}

	/** Report an action and keep the widget in sync if it is on screen. */
	function afterChange(ctx: ExtensionContext, note: string): void {
		notifyState(ctx, note);
		if (widgetVisible) refreshWidget(ctx);
	}

	const getArgumentCompletions = (prefix: string) => {
		const p = prefix.trimStart();
		if (/\s/.test(p)) return null;
		return SUBCOMMANDS.filter((c) => c.value.startsWith(p.toLowerCase())).map((c) => ({
			value: c.value,
			label: c.value,
			description: c.description,
		}));
	};

	const handler = async (args: string, ctx: ExtensionContext) => {
		const raw = (args ?? "").trim();
		const [command, ...rest] = raw.split(/\s+/);
		const sub = (command ?? "").toLowerCase();
		const tail = rest.join(" ").trim();

		try {
			switch (sub) {
				case "": {
					// No args toggles the widget; non-TUI has no widget, so print.
					if (ctx.mode !== "tui") {
						printList(ctx);
						return;
					}
					toggleWidget(ctx);
					if (!widgetVisible) notifyState(ctx, "Reminders hidden");
					return;
				}
				case "list": {
					if (ctx.mode === "tui") showWidget(ctx);
					else printList(ctx);
					return;
				}
				case "help": {
					notifyState(ctx, USAGE);
					return;
				}
				case "new-idea":
				case "idea": {
					if (!tail) throw new Error("usage: /remind new-idea <text>");
					afterChange(ctx, await applyAction("add-idea", undefined, tail));
					return;
				}
				case "new-todo":
				case "todo": {
					if (!tail) throw new Error("usage: /remind new-todo <text>");
					afterChange(ctx, await applyAction("add-todo", undefined, tail));
					return;
				}
				case "file": {
					if (!tail) {
						const file = resolveFile();
						const source = process.env.PI_REMINDERS_FILE?.trim()
							? "PI_REMINDERS_FILE"
							: savedPath()
								? "saved"
								: "default";
						notifyState(ctx, `Reminders file: ${file} (${source})`);
						return;
					}
					if (tail === "reset" || tail === "default") {
						resetFile();
						afterChange(ctx, `Reminders file reset to default: ${resolveFile()}`);
						return;
					}
					const saved = setFile(tail);
					const envNote = process.env.PI_REMINDERS_FILE?.trim()
						? " (note: PI_REMINDERS_FILE is set and takes precedence)"
						: "";
					afterChange(ctx, `Reminders file set to: ${saved}${envNote}`);
					return;
				}
				case "done":
				case "undone":
				case "remove":
				case "rm":
				case "delete":
				case "edit": {
					const action: Action =
						sub === "done" ? "done" : sub === "undone" ? "undone" : sub === "edit" ? "edit" : "remove";
					const [refText, ...textParts] = tail.split(/\s+/);
					const ref = parseRef(refText ?? "");
					if (!ref) {
						throw new Error(`usage: /remind ${sub} <id>${action === "edit" ? " <text>" : ""}`);
					}
					afterChange(ctx, await applyAction(action, ref, textParts.join(" ").trim()));
					return;
				}
				default:
					notifyState(ctx, `Unknown subcommand "${sub}" — try /remind help`);
					return;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) ctx.ui.notify(`remind: ${message}`, "error");
		}
	};

	pi.registerCommand("remind", {
		description: "Print and manage your ideas & todos",
		getArgumentCompletions,
		handler,
	});
	pi.registerCommand("reminders", {
		description: "Alias for /remind",
		getArgumentCompletions,
		handler,
	});

	// Print the list once when a session starts, the same way `/session` prints.
	// /resume and /reload re-fire session_start, so skip when a block is
	// already present in the transcript to avoid duplicate reminders blocks.
	pi.on("session_start", (_event, ctx) => {
		try {
			ensureFile();
			if (!hasRemindersEntry(ctx)) printList(ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) ctx.ui.notify(`remind: ${message}`, "error");
		}
	});
}