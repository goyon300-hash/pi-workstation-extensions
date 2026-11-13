import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hostImport, hostRequire, extensionPath, packageRoot, blockNetwork } from './host.mjs';

const root = fs.mkdtempSync(join(tmpdir(), 'pi-workstation-test-'));
process.env.HOME = join(root, 'home');
process.env.XDG_CONFIG_HOME = join(root, 'config');
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
process.env.PI_REMINDERS_FILE = join(root, 'private', 'reminders.md');
process.env.PI_NTFY_CONFIG = join(root, 'ntfy.conf');
process.env.PI_NTFY_NOTIFY_CONFIG = join(root, 'notify.txt');
process.env.PI_WORKSTATION_TIME_ZONE = 'UTC';
process.env.PI_WORKSTATION_LOCALE = 'en-GB';
blockNetwork();
const { loadExtensions, clearExtensionCache } = await hostImport('dist/core/extensions/loader.js');
const { SessionManager, DefaultResourceLoader } = await hostImport('dist/index.js');
const { initTheme } = await hostImport('dist/modes/interactive/theme/theme.js');
initTheme();
const { visibleWidth } = await import(hostRequire.resolve('@earendil-works/pi-tui'));
let passed = 0;
const ok = label => { passed++; console.log(`PASS ${label}`); };
const agent = process.env.PI_CODING_AGENT_DIR;
const theme = { fg: (_color, s) => s, bold: s => s };
const manifest = JSON.parse(fs.readFileSync(join(packageRoot, 'package.json'), 'utf8'));
let timers = new Set();
const originalInterval = globalThis.setInterval;
const originalClear = globalThis.clearInterval;

async function harness(name, mode = 'tui') {
  const loaded = await loadExtensions([extensionPath(name)], root);
  assert.deepEqual(loaded.errors, [], name);
  const ext = loaded.extensions[0];
  const sm = SessionManager.inMemory(root);
  const entries = [];
  loaded.runtime.appendEntry = (type, data) => { entries.push({ type, data }); sm.appendCustomEntry(type, data); };
  loaded.runtime.getSettings = () => ({ compaction: { enabled: false } });
  const notices = [], statuses = new Map(), widgets = new Map();
  let footer;
  const ctx = { mode, hasUI: mode === 'tui' || mode === 'rpc', cwd: root, sessionManager: sm,
    thinkingLevel: 'off', model: undefined, getContextUsage: () => undefined,
    ui: { notify: (text, level) => notices.push({ text, level }),
      setStatus: (key, value) => value === undefined ? statuses.delete(key) : statuses.set(key, value),
      setWidget: (key, value) => value === undefined ? widgets.delete(key) : widgets.set(key, value),
      setFooter: factory => { footer = factory; } } };
  return { ext, sm, ctx, entries, notices, statuses, widgets, get footer() { return footer; },
    emit: async (type, fields = {}) => { for (const fn of ext.handlers.get(type) ?? []) await fn({ type, ...fields }, ctx); },
    command: (name, args) => ext.commands.get(name).handler(args, ctx) };
}
try {
  assert.equal(manifest.pi.extensions.length, 7);
  assert.ok(!manifest.pi.extensions.some(p => p.includes('/lib/')));
  assert.equal(manifest.dependencies, undefined);
  // Missing topic is disabled, rather than registering a tool that cannot send.
  const silent = await harness('ntfy-send.ts');
  assert.equal(silent.ext.tools.size, 0);
  fs.writeFileSync(process.env.PI_NTFY_CONFIG, 'NTFY_TOPIC=fixture-topic-not-a-real-destination\n');
  fs.writeFileSync(process.env.PI_NTFY_NOTIFY_CONFIG, ['agent_start', 'ui_prompt_start', 'tool_error', 'agent_question', 'agent_finished', 'agent_interrupted'].map(name =>
    `[${name}]\nenabled=true\nemoji=🔔\ntitle=${name} {tool}\nmessage=${name === 'agent_start' ? '@fixture-body-is-literal' : 'Fixture {cwd} {kind}'}\ntags=computer\npriority=3\n`).join('\n'));
  clearExtensionCache();
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: agent, additionalExtensionPaths: [packageRoot], noSkills: true, noPromptTemplates: true, noThemes: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 7);
  ok('manifest discovers exactly seven entry points with host dependencies, no live config');

  const clock = await harness('clock-timestamps.ts');
  globalThis.setInterval = (fn, ms) => { assert.equal(ms, 1000); const timer = { fn }; timers.add(timer); return timer; };
  globalThis.clearInterval = timer => timers.delete(timer);
  await clock.emit('session_start');
  assert.equal(timers.size, 1);
  assert.match(clock.statuses.get('local-clock'), /^\d\d:\d\d$/);
  await clock.emit('session_start', { reason: 'reload' });
  assert.equal(timers.size, 1);
  await clock.emit('message_end', { message: { role: 'user' } });
  await clock.emit('message_end', { message: { role: 'toolResult' } });
  await clock.emit('turn_end');
  assert.deepEqual(clock.entries.map(e => e.data.role), ['user', 'assistant']);
  const rendered = clock.ext.entryRenderers.get('local-message-timestamp')({ data: clock.entries[0].data }, {}, theme);
  assert.match(rendered.render(100).join(''), /User/);
  await clock.emit('session_shutdown');
  assert.equal(timers.size, 0); assert.equal(clock.statuses.size, 0);
  const rpcClock = await harness('clock-timestamps.ts', 'rpc');
  await rpcClock.emit('session_start'); assert.equal(timers.size, 0);
  globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear;
  ok('clock renders entries, guards TUI mode and cleans/replaces its timer');

  // A fresh English-locale process proves the default does not follow host language.
  // Leave the extension time-zone override unset: it must still use the host zone.
  const localeEnv = { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TZ: 'UTC' };
  delete localeEnv.PI_WORKSTATION_LOCALE;
  delete localeEnv.PI_WORKSTATION_TIME_ZONE;
  const localeCheck = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { hostImport, extensionPath, blockNetwork } from ${JSON.stringify(new URL('./host.mjs', import.meta.url).href)};
    blockNetwork();
    assert.equal(Intl.DateTimeFormat().resolvedOptions().locale, 'en-US');
    assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'UTC');
    const { loadExtensions, clearExtensionCache } = await hostImport('dist/core/extensions/loader.js');
    const options = { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', hourCycle:'h23' };
    const at = Date.parse('2026-11-13T13:14:00Z');
    async function check(locale) {
      clearExtensionCache();
      const loaded = await loadExtensions([extensionPath('clock-timestamps.ts')], ${JSON.stringify(root)});
      assert.deepEqual(loaded.errors, []);
      const renderer = loaded.extensions[0].entryRenderers.get('local-message-timestamp');
      const text = renderer({data:{role:'user',at}}, {}, {fg:(_color,s)=>s}).render(100).join('');
      assert.ok(text.includes(new Intl.DateTimeFormat(locale, options).format(new Date(at))), text);
    }
    await check('pl-PL');
    process.env.PI_WORKSTATION_LOCALE = 'en-US';
    await check('en-US');
  `], { encoding: 'utf8', env: localeEnv });
  assert.equal(localeCheck.status, 0, localeCheck.stderr);
  ok('clock defaults to Polish on an English host, honors locale override and retains host time zone');

  const mode = await harness('mode.ts');
  await mode.emit('session_start'); assert.match(mode.statuses.get('mode'), /PC/);
  await mode.command('ntfy', 'phone');
  assert.equal(fs.readFileSync(join(agent, 'mode.txt'), 'utf8'), 'phone\n');
  assert.match(mode.statuses.get('mode'), /phone/);
  await mode.command('ntfy', 'bad'); assert.equal(mode.notices.at(-1).level, 'warning');
  assert.deepEqual(mode.ext.commands.get('ntfy').getArgumentCompletions('ph').map(c => c.value), ['phone']);
  fs.unlinkSync(join(agent, 'mode.txt')); fs.mkdirSync(join(agent, 'mode.txt'));
  await assert.rejects(mode.command('ntfy', 'pc'));
  await mode.command('ntfy', 'invalid');
  assert.match(mode.notices.at(-1).text, /Current \[mode: phone\]/);
  fs.rmdirSync(join(agent, 'mode.txt')); fs.writeFileSync(join(agent, 'mode.txt'), 'phone\n');
  await mode.emit('session_shutdown'); assert.equal(mode.statuses.size, 0);
  ok('mode uses isolated agent directory and persists valid commands only');

  const footer = await harness('footer.ts');
  // Exercise the declared read-only contract (which does not promise getEntryCount).
  const sm = footer.sm;
  footer.ctx.sessionManager = Object.fromEntries(['getEntries', 'getSessionId', 'getLeafId', 'getCwd', 'getSessionName'].map(k => [k, sm[k].bind(sm)]));
  let disposed = 0;
  const statuses = new Map([['mode', 'PC'], ['local-clock', '12:34']]);
  const footerData = { getExtensionStatuses: () => statuses, getGitBranch: () => 'fixture', getAvailableProviderCount: () => 1, onBranchChange: () => () => disposed++ };
  await footer.emit('session_start');
  const component = footer.footer({ requestRender() {} }, theme, footerData);
  for (const width of [0, 1, 5, 20, 80, 160]) {
    const lines = component.render(width);
    assert.equal(lines.length, 2, `footer width ${width}`);
    assert.ok(lines.every(s => visibleWidth(s) <= width));
  }
  assert.match(component.render(160)[0], /PC\s+12:34/);
  assert.ok(!component.render(160)[1].includes('(auto)'));
  statuses.clear(); component.invalidate(); assert.equal(component.render(80).length, 2);
  component.dispose(); assert.equal(disposed, 1);
  await footer.emit('session_shutdown'); assert.equal(footer.footer, undefined);
  ok('real Pi 1.5.2 FooterComponent renders against read-only contract, narrow widths, disposal');

  const reminders = await harness('reminders.ts');
  await reminders.emit('session_start'); assert.equal(reminders.entries.length, 1);
  await reminders.emit('session_start', { reason: 'reload' }); assert.equal(reminders.entries.length, 1);
  await reminders.command('remind', 'new-idea Fixture idea');
  await reminders.command('remind', 'new-todo Fixture task');
  await reminders.command('remind', 'done 1'); assert.equal(reminders.notices.at(-1).level, 'error');
  await reminders.command('remind', 'done t1');
  assert.match(fs.readFileSync(process.env.PI_REMINDERS_FILE, 'utf8'), /\[x\] Fixture task/);
  await reminders.command('remind', 'edit i1 Fixture edited');
  await reminders.command('remind', 'list');
  const view = reminders.widgets.get('reminders')({}, theme);
  for (const width of [1, 10, 80]) assert.ok(view.render(width).every(s => visibleWidth(s) <= width));
  view.invalidate();
  await reminders.command('remind', 'remove i1');
  assert.ok(!fs.readFileSync(process.env.PI_REMINDERS_FILE, 'utf8').includes('Fixture edited'));
  const other = join(root, 'selected file.md');
  await reminders.command('remind', `file ${other}`);
  assert.equal(fs.readFileSync(join(agent, 'reminders.path'), 'utf8').trim(), other);
  delete process.env.PI_REMINDERS_FILE;
  await reminders.command('remind', 'new-todo Selected fixture');
  assert.match(fs.readFileSync(other, 'utf8'), /Selected fixture/);
  await reminders.command('remind', 'file reset');
  assert.ok(!fs.existsSync(join(agent, 'reminders.path')));
  // Legacy txt fallback is retained when the default md file is absent.
  fs.rmSync(join(agent, 'reminders.md'), { force: true });
  fs.writeFileSync(join(agent, 'reminders.txt'), '## Todos\n- [ ] Legacy fixture\n');
  await reminders.command('remind', 'done t1');
  assert.match(fs.readFileSync(join(agent, 'reminders.txt'), 'utf8'), /\[x\] Legacy fixture/);
  ok('reminders startup deduplication, CRUD, ambiguous IDs, rendering, configured paths, txt fallback');

  // Explicit overrides above and the historical home/XDG config locations both work.
  delete process.env.PI_NTFY_CONFIG;
  fs.mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
  fs.writeFileSync(join(process.env.XDG_CONFIG_HOME, 'ntfy.conf'), 'NTFY_TOPIC=fixture-topic-not-a-real-destination\r\n');
  clearExtensionCache();
  assert.equal((await harness('ntfy-send.ts')).ext.tools.size, 1);
  delete process.env.XDG_CONFIG_HOME;
  fs.mkdirSync(join(process.env.HOME, '.config'), { recursive: true });
  fs.writeFileSync(join(process.env.HOME, '.config', 'ntfy.conf'), 'NTFY_TOPIC=fixture-topic-not-a-real-destination\n');
  delete process.env.PI_NTFY_NOTIFY_CONFIG;
  fs.copyFileSync(join(root, 'notify.txt'), join(agent, 'ntfy-notify.txt'));
  clearExtensionCache();
  const topicFile = join(process.env.HOME, '.config', 'ntfy.conf');
  for (const topic of ['@private-file', 'bad/topic', 'bad?priority=5', 'bad topic', 'bad\tcontrol']) {
    fs.writeFileSync(topicFile, `NTFY_TOPIC=${topic}\n`);
    clearExtensionCache();
    assert.equal((await harness('ntfy-send.ts')).ext.tools.size, 0, topic);
    assert.equal((await harness('ntfy-notify.ts')).ext.handlers.size, 0, topic);
  }
  fs.writeFileSync(topicFile, 'NTFY_TOPIC=fixture-topic-not-a-real-destination\n');
  clearExtensionCache();
  ok('private ntfy config compatibility and unsafe topic allowlist rejection');

  const calls = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://ntfy.sh/fixture-topic-not-a-real-destination');
    // Native Headers enforces the actual byte-string constraint.
    new Headers(init.headers);
    calls.push({ url, ...init }); return { ok: true, status: 200 };
  };
  const notify = await harness('ntfy-notify.ts');
  fs.writeFileSync(join(agent, 'mode.txt'), 'pc\n');
  await notify.emit('agent_start'); assert.equal(calls.length, 0);
  fs.writeFileSync(join(agent, 'mode.txt'), 'phone\n');
  await notify.emit('agent_start'); assert.equal(calls.length, 1);
  assert.equal(calls[0].body, '@fixture-body-is-literal');
  await notify.emit('ui_prompt_start', { kind: 'confirm' });
  await notify.emit('tool_execution_end', { toolName: 'fixture', isError: false }); assert.equal(calls.length, 2);
  await notify.emit('tool_execution_end', { toolName: 'fixture', isError: true });
  await notify.emit('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'A question? ”' }] } });
  await notify.emit('agent_settled', { aborted: false });
  await notify.emit('agent_settled', { aborted: true });
  await notify.emit('agent_settled', { aborted: false });
  assert.equal(calls.length, 6);
  const title = call => Buffer.from(call.headers.Title.slice(10, -2), 'base64').toString('utf8');
  assert.match(title(calls[3]), /agent_question/);
  assert.match(title(calls[4]), /agent_interrupted/);
  assert.match(title(calls[5]), /agent_finished/);
  assert.match(calls[0].headers.Title, /^=\?UTF-8\?B\?/);
  assert.ok(!('X-Title' in calls[0].headers));
  ok('automatic notification event gates, phone/pc modes, Unicode title and final question classification');
  const notifyFile = join(agent, 'ntfy-notify.txt');
  const configBefore = fs.readFileSync(notifyFile, 'utf8');
  const stderr = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(' '));
  try {
    for (const field of ['title', 'tags']) {
      fs.writeFileSync(notifyFile, `[agent_start]\nenabled=true\n${field}=bad\tcontrol\nmessage=@literal-body\n`);
      await notify.emit('agent_start');
      assert.equal(calls.length, 6);
    }
  } finally { console.error = stderr; fs.writeFileSync(notifyFile, configBefore); }
  assert.equal(errors.length, 2);
  ok('automatic title/tag header controls are rejected before any request');

  const sender = await harness('ntfy-send.ts');
  const execute = sender.ext.tools.get('ntfy_send').definition.execute;
  fs.writeFileSync(join(agent, 'mode.txt'), 'pc\n');
  let result = await execute('fixture', { title: 'Zażółć 🔔', message: '@fixture-body-is-literal' }, undefined);
  assert.notEqual(result.isError, true); assert.equal(calls.length, 7);
  assert.equal(calls.at(-1).body, '@fixture-body-is-literal');
  const controller = new AbortController(); controller.abort();
  await execute('fixture', { title: 'Fixture', message: 'Fixture' }, controller.signal);
  assert.equal(calls.at(-1).signal.aborted, true);
  const before = calls.length;
  for (const title of ['bad\nInjected: value', 'bad\rtitle', 'bad\ttitle', 'bad\u0000title']) {
    await assert.rejects(execute('fixture', { title, message: '@literal' }), /control characters/);
    assert.equal(calls.length, before);
  }
  result = await execute('fixture', { title: 'x'.repeat(101), message: '' });
  assert.equal(result.isError, true); assert.equal(calls.length, before);
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  result = await execute('fixture', { title: 'Fixture', message: 'Fixture' });
  assert.equal(result.isError, true); assert.match(result.content[0].text, /503/);
  globalThis.fetch = async () => { throw new Error('Fixture transport failure'); };
  await assert.rejects(execute('fixture', { title: 'Fixture', message: 'Fixture' }), /Fixture transport failure/);
  ok('manual tool: pc mode unaffected, Unicode, optional/aborted signal, limits, HTTP and transport failure');
  console.log(`\n${passed} workstation test groups passed (all network mocked or blocked).`);
} finally {
  globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear;
  fs.rmSync(root, { recursive: true, force: true });
}
