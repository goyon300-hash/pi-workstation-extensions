// Run: npm test (or node tests/conversation-sync.mjs)
// Uses the installed Pi loader, real SessionManager fixtures and an SDK agent with a fake stream.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { hostRoot, extensionPath, blockNetwork } from './host.mjs';
const base = dirname(hostRoot) + '/';
const extension = extensionPath('pi-conversation-sync.ts');
blockNetwork();
process.env.PI_WORKSTATION_TIME_ZONE = 'Europe/Warsaw';
const root = fs.mkdtempSync(join(tmpdir(), 'pi-conversation-sync-test-'));
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
const agentDir = process.env.PI_CODING_AGENT_DIR;
const output = join(root, 'vault with spaces');
const configPath = join(agentDir, 'pi-conversation-sync/config.json');
const { SessionManager, SettingsManager, ModelRuntime, DefaultResourceLoader, createAgentSession } = await import(base + 'pi-coding-agent/dist/index.js');
const { loadExtensions, clearExtensionCache } = await import(base + 'pi-coding-agent/dist/core/extensions/loader.js');
const { AssistantMessageEventStream } = await import(base + 'pi-ai/dist/utils/event-stream.js');
let passed = 0;
function ok(name) { passed++; console.log(`PASS ${name}`); }
const mdFiles = (dir = output) => fs.existsSync(dir) ? fs.readdirSync(dir).filter(p => p.endsWith('.md')).map(p => join(dir, p)) : [];
const user = (text, timestamp = Date.parse('2026-11-12T04:18:00Z')) => ({ role: 'user', content: text, timestamp });
const assistant = (content, timestamp = Date.parse('2026-11-12T04:19:00Z')) => ({
  role: 'assistant', content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
  api: 'openai-completions', provider: 'test', model: 'fake', timestamp, stopReason: 'stop',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
function statePath(sm) { return join(agentDir, 'pi-conversation-sync/sessions', createHash('sha256').update(sm.getSessionId()).digest('hex') + '.json'); }
function tracked(sm) { return JSON.parse(fs.readFileSync(statePath(sm), 'utf8')).paths[0]; }
async function harness(sm = SessionManager.create(root, join(root, 'sessions'))) {
  const loaded = await loadExtensions([extension], root);
  assert.deepEqual(loaded.errors, []);
  const ext = loaded.extensions[0];
  assert.equal(ext.tools.size, 0);
  assert.deepEqual([...ext.commands.keys()], ['save-to-md']);
  const notices = [];
  const ctx = { sessionManager: sm, cwd: root, hasUI: true, ui: { notify: (message, level) => notices.push({ message, level }) } };
  const emit = async (type, event = {}) => { for (const h of ext.handlers.get(type) ?? []) await h({ type, ...event }, ctx); };
  const command = async args => ext.commands.get('save-to-md').handler(args, ctx);
  await emit('session_start', { reason: 'startup' });
  return { sm, ctx, ext, emit, command, notices };
}
try {
  let h = await harness();
  await h.emit('turn_start');
  await h.command('');
  assert.equal(mdFiles().length, 0);
  assert.match(h.notices.at(-1).message, /Nothing to export/);
  assert.ok(!fs.existsSync(statePath(h.sm)));
  ok('1 empty session: no transcript or state');

  await h.command(`dir "${output}"`);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).directory, output);
  assert.equal(mdFiles().length, 0);
  const first = user('  # Original Markdown\n\n**bold**\n\n```ts\nlet x = 1;\n```  ');
  await h.emit('message_end', { message: first });
  await h.emit('context'); // Deliberately before append: must not export a transient message.
  assert.equal(mdFiles().length, 0);
  h.sm.appendMessage(first);
  await h.emit('context');
  let file = tracked(h.sm);
  let content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes(first.content));
  assert.match(content, /### User · 05:18/);
  assert.match(content, /^keep_archived: true$/m, 'frontmatter keeps archived transcripts marked');
  assert.equal(mdFiles().length, 1);
  ok('2 first persisted user creates transcript before assistant');

  const mid = assistant([
    { type: 'thinking', thinking: 'SECRET_THINKING' },
    { type: 'text', text: 'Intermediate **answer**' },
    { type: 'toolCall', id: 'call', name: 'bash', arguments: { command: 'SECRET_ARGUMENT' } },
    { type: 'image', data: 'SECRET_IMAGE', mimeType: 'image/png' },
  ]);
  h.sm.appendMessage(mid);
  h.sm.appendMessage({ role: 'toolResult', toolName: 'bash', toolCallId: 'call', content: [{ type: 'text', text: 'SECRET_RESULT' }], isError: false, timestamp: mid.timestamp });
  await h.emit('turn_end');
  assert.match(fs.readFileSync(file, 'utf8'), /Intermediate \*\*answer\*\*/);
  ok('3 intermediate completed assistant turn updates transcript');
  h.sm.appendMessage(assistant('Final answer', Date.parse('2026-11-12T04:20:00Z')));
  await h.emit('turn_end');
  const second = user([{ type: 'text', text: 'Second question' }, { type: 'image', data: 'SECRET_IMAGE', mimeType: 'image/png' }], Date.parse('2026-11-12T04:21:00Z'));
  await h.emit('message_end', { message: second }); h.sm.appendMessage(second); await h.emit('context');
  h.sm.appendMessage(assistant('Second answer', Date.parse('2026-11-12T04:22:00Z')));
  h.sm.appendMessage(assistant([{ type: 'thinking', thinking: 'SECRET_THINKING' }]));
  h.sm.appendCustomMessageEntry('internal', 'SECRET_CUSTOM', false);
  h.sm.appendMessage({ role: 'system', content: 'SECRET_SYSTEM', timestamp: first.timestamp });
  await h.emit('turn_end'); await h.emit('agent_settled');
  content = fs.readFileSync(file, 'utf8');
  let position = -1;
  for (const text of ['# Original Markdown', 'Intermediate **answer**', 'Final answer', 'Second question', 'Second answer']) {
    const next = content.indexOf(text); assert.ok(next > position, text); position = next;
  }
  assert.equal((content.match(/^### Assistant/gm) ?? []).length, 4 - 1);
  assert.ok(!content.includes('SECRET_'));
  ok('4-6 chronological history, tools/reasoning/images/system/custom excluded');

  const before = fs.statSync(file, { bigint: true }).mtimeNs;
  await h.command(''); await h.emit('agent_settled');
  assert.equal(fs.statSync(file, { bigint: true }).mtimeNs, before);
  assert.equal(mdFiles().length, 1);
  ok('12 repeated export is byte/mtime stable, no duplicates');

  const sessionPath = h.sm.getSessionFile();
  const originalJsonl = fs.readFileSync(sessionPath, 'utf8');
  h = await harness(SessionManager.open(sessionPath));
  await h.emit('session_start', { reason: 'resume' });
  await h.emit('context'); await h.emit('turn_end'); await h.emit('agent_settled');
  assert.equal(fs.statSync(file, { bigint: true }).mtimeNs, before);
  assert.equal(fs.readFileSync(sessionPath, 'utf8'), originalJsonl);
  const unexported = SessionManager.create(root, join(root, 'sessions'));
  unexported.appendMessage(user('Old resumed history'));
  const resumed = await harness(SessionManager.open(unexported.getSessionFile()));
  await resumed.emit('session_start', { reason: 'resume' });
  await resumed.emit('context'); await resumed.emit('agent_settled');
  assert.ok(!fs.existsSync(statePath(resumed.sm)));
  ok('7 resumed existing and unexported sessions remain untouched');
  const nextUser = user('New input after resume');
  await resumed.emit('message_end', { message: nextUser }); resumed.sm.appendMessage(nextUser); await resumed.emit('context');
  const resumedText = fs.readFileSync(tracked(resumed.sm), 'utf8');
  assert.match(resumedText, /Old resumed history/); assert.match(resumedText, /New input after resume/);
  ok('8 resumed + new input exports entire history');
  const priorCalls = h.sm.getEntries().length;
  await h.command('');
  assert.match(h.notices.at(-1).message, new RegExp('Saved: '));
  assert.equal(h.sm.getEntries().length, priorCalls);
  assert.equal(tracked(h.sm), file);
  ok('9 manual resumed export without model or session changes');

  h.sm.appendSessionInfo('Test / name: $1 **markdown**');
  const jsonlBeforeRename = fs.readFileSync(sessionPath, 'utf8');
  await h.emit('session_info_changed');
  const renamed = tracked(h.sm);
  assert.notEqual(renamed, file); assert.ok(!fs.existsSync(file));
  assert.match(renamed, /Test - name- \$1/);
  assert.match(fs.readFileSync(renamed, 'utf8'), /# Test \/ name: \$1 \*\*markdown\*\*/);
  assert.equal(fs.readFileSync(sessionPath, 'utf8'), jsonlBeforeRename);
  file = renamed;
  const unnamed = await harness(); unnamed.sm.appendSessionInfo('Not exported'); await unnamed.emit('session_info_changed');
  assert.ok(!fs.existsSync(statePath(unnamed.sm)));
  ok('11 naming renames only an existing transcript, preserves session JSONL');

  const newOutput = join(root, 'second destination');
  const oldOther = tracked(resumed.sm);
  await h.command(`dir ${newOutput}`);
  assert.equal(mdFiles(newOutput).length, 0);
  assert.ok(fs.existsSync(file));
  await h.command('');
  const moved = tracked(h.sm);
  assert.equal(dirname(moved), newOutput); assert.ok(!fs.existsSync(file));
  assert.ok(fs.existsSync(oldOther));
  assert.equal(mdFiles(newOutput).length, 1);
  const fresh = await harness(); fresh.sm.appendMessage(user('Restart directory persists')); await fresh.command('');
  assert.equal(dirname(tracked(fresh.sm)), newOutput);
  await fresh.command(`dir "~/../../${root.slice(1)}/tilde destination"`);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).directory, join(root, 'tilde destination'));
  await h.command(`dir '${newOutput}'`);
  ok('10 directory spaces/quotes/tilde, persistent setting, lazy move, unrelated history untouched');

  const snapshot = h.sm.getBranch();
  const firstUserId = snapshot.find(e => e.type === 'message' && e.message.role === 'user').id;
  const lastUserId = snapshot.filter(e => e.type === 'message' && e.message.role === 'user').at(-1).id;
  h.sm.appendCompaction('SECRET_COMPACTION', lastUserId, 10000);
  await h.command('');
  content = fs.readFileSync(tracked(h.sm), 'utf8');
  assert.match(content, /Original Markdown/); assert.match(content, /Second answer/); assert.ok(!content.includes('SECRET_COMPACTION'));
  ok('13 compaction preserves original pre-compaction history');
  const beforeBranch = fs.readFileSync(tracked(h.sm), 'utf8');
  h.sm.branchWithSummary(firstUserId, 'SECRET_BRANCH_SUMMARY');
  await h.emit('session_tree');
  assert.equal(fs.readFileSync(tracked(h.sm), 'utf8'), beforeBranch);
  const alternate = user('Active branch question');
  await h.emit('message_end', { message: alternate }); h.sm.appendMessage(alternate); await h.emit('context');
  content = fs.readFileSync(tracked(h.sm), 'utf8');
  assert.match(content, /Original Markdown/); assert.match(content, /Active branch question/);
  assert.ok(!content.includes('Second answer')); assert.ok(!content.includes('SECRET_BRANCH_SUMMARY'));
  ok('14 tree navigation alone does not sync; next input exports only active branch');

  const trackedBeforeRestart = tracked(h.sm);
  clearExtensionCache();
  h = await harness(SessionManager.open(sessionPath));
  await h.command('');
  assert.equal(tracked(h.sm), trackedBeforeRestart);
  assert.equal(mdFiles(newOutput).filter(f => fs.readFileSync(f, 'utf8').includes(`pi_session_id: "${h.sm.getSessionId()}"`)).length, 1);
  // Separate process: load extension and execute the command against the same fixture/config.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { blockNetwork } from ${JSON.stringify(new URL('./host.mjs', import.meta.url).href)};
    blockNetwork();
    import { loadExtensions } from ${JSON.stringify(base + 'pi-coding-agent/dist/core/extensions/loader.js')};
    import { SessionManager } from ${JSON.stringify(base + 'pi-coding-agent/dist/index.js')};
    const loaded = await loadExtensions([${JSON.stringify(extension)}], ${JSON.stringify(root)});
    if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
    const sm = SessionManager.open(${JSON.stringify(sessionPath)});
    await loaded.extensions[0].commands.get('save-to-md').handler('', {sessionManager:sm,hasUI:true,ui:{notify:(m,l)=>{if(l==='error')throw new Error(m)}}});
  `], { encoding: 'utf8', env: process.env });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(tracked(h.sm), trackedBeforeRestart);
  ok('15 reload and actual process restart reuse stable session file association');

  // Same-minute collision, unrelated destination and symlink safety.
  const collisionA = await harness(); collisionA.sm.appendMessage(user('Collision A')); await collisionA.command('');
  const collisionB = await harness(); collisionB.sm.appendMessage(user('Collision B')); await collisionB.command('');
  assert.notEqual(tracked(collisionA.sm), tracked(collisionB.sm));
  assert.match(fs.readFileSync(tracked(collisionA.sm), 'utf8'), /Collision A/);
  const victim = join(root, 'unrelated.md'); fs.writeFileSync(victim, 'Do not alter');
  fs.unlinkSync(tracked(collisionB.sm)); fs.symlinkSync(victim, tracked(collisionB.sm));
  await collisionB.command('');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'Do not alter'); assert.equal(collisionB.notices.at(-1).level, 'error');
  const hashBeforeError = fs.readFileSync(tracked(collisionA.sm), 'utf8');
  await collisionA.command(`dir ${victim}`); assert.equal(collisionA.notices.at(-1).level, 'error');
  await collisionA.command('dir relative/path'); assert.equal(collisionA.notices.at(-1).level, 'error');
  assert.equal(fs.readFileSync(tracked(collisionA.sm), 'utf8'), hashBeforeError);
  collisionA.sm.appendMessage(assistant('Pending locked update'));
  fs.writeFileSync(statePath(collisionA.sm) + '.lock', String(process.pid));
  await collisionA.command(''); assert.equal(collisionA.notices.at(-1).level, 'error');
  assert.equal(fs.readFileSync(tracked(collisionA.sm), 'utf8'), hashBeforeError);
  fs.writeFileSync(statePath(collisionA.sm) + '.lock', '2147483647');
  await collisionA.command(''); assert.equal(collisionA.notices.at(-1).level, 'info');
  assert.ok(!fs.existsSync(statePath(collisionA.sm) + '.lock'));
  ok('collision/unrelated-file/symlink/invalid-directory/live and exited writer protection');

  const forkedManager = SessionManager.forkFrom(sessionPath, root, join(root, 'forked-sessions'));
  const forked = await harness(forkedManager);
  await forked.emit('session_start', { reason: 'fork' });
  assert.ok(!fs.existsSync(statePath(forkedManager)));
  await forked.command('');
  assert.notEqual(forkedManager.getSessionId(), h.sm.getSessionId());
  assert.notEqual(tracked(forkedManager), tracked(h.sm));
  assert.match(fs.readFileSync(tracked(forkedManager), 'utf8'), /Active branch question/);
  ok('fork receives independent identity and transcript without exporting on load');

  const cjsFS = (await import('node:module')).createRequire(import.meta.url)('node:fs');
  const originalRename = cjsFS.renameSync;
  const validBeforeFailure = fs.readFileSync(tracked(collisionA.sm), 'utf8');
  collisionA.sm.appendMessage(assistant('After failed atomic replacement'));
  try {
    cjsFS.renameSync = (from, to) => {
      if (to.endsWith('.md')) throw Object.assign(new Error('Injected replacement failure'), { code: 'EACCES' });
      return originalRename(from, to);
    };
    (await import('node:module')).syncBuiltinESMExports();
    clearExtensionCache();
    const failing = await harness(collisionA.sm);
    await failing.command('');
    assert.equal(failing.notices.at(-1).level, 'error');
    assert.equal(fs.readFileSync(tracked(collisionA.sm), 'utf8'), validBeforeFailure);
    assert.ok(!fs.readdirSync(newOutput).some(p => p.endsWith('.tmp')));
  } finally {
    cjsFS.renameSync = originalRename;
    (await import('node:module')).syncBuiltinESMExports();
    clearExtensionCache();
  }
  await collisionA.command('');
  assert.match(fs.readFileSync(tracked(collisionA.sm), 'utf8'), /After failed atomic replacement/);
  ok('failed atomic replace preserves complete previous file, cleans temp, next save recovers');

  // Controlled local integration using native SDK lifecycle and a deterministic zero-network stream.
  await h.command(`dir ${output}`);
  const sdkAgentDir = join(root, 'sdk-agent');
  fs.mkdirSync(join(sdkAgentDir, 'extensions'), { recursive: true });
  fs.symlinkSync(extension, join(sdkAgentDir, 'extensions/pi-conversation-sync.ts'));
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: sdkAgentDir, noSkills: true, noPromptTemplates: true, noThemes: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.ok(loader.getExtensions().extensions.some(e => e.path.endsWith('pi-conversation-sync.ts')));
  const runtime = await ModelRuntime.create({ authPath: join(root, 'sdk-auth.json'), modelsPath: null, modelsStorePath: join(root, 'sdk-models-store.json'), refreshOnCreate: false });
  runtime.registerProvider('test', {
    api: 'openai-completions', apiKey: 'test-only-not-a-secret', baseUrl: 'http://127.0.0.1:1',
    models: [{ id: 'fake', name: 'Deterministic fixture', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  const sm = SessionManager.create(root, join(root, 'sdk-sessions'));
  const { session } = await createAgentSession({ cwd: root, agentDir: sdkAgentDir, resourceLoader: loader, modelRuntime: runtime,
    model: runtime.getModel('test', 'fake'), thinkingLevel: 'off', tools: [], sessionManager: sm,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
  });
  let calls = 0;
  let earlyTranscript;
  const events = [];
  await session.bindExtensions({ uiContext: { notify: () => {} }, onError: error => { throw new Error(JSON.stringify(error)); } });
  session.subscribe(event => events.push(event.type));
  session.agent.streamFunction = () => {
    calls++;
    // At provider entry, the source JSONL and Markdown already contain the first user, no assistant yet.
    const jsonl = fs.readFileSync(sm.getSessionFile(), 'utf8');
    assert.match(jsonl, /SDK first persisted user/);
    earlyTranscript = fs.readFileSync(tracked(sm), 'utf8');
    assert.match(earlyTranscript, /SDK first persisted user/);
    assert.ok(!earlyTranscript.includes('SDK final answer'));
    const stream = new AssistantMessageEventStream();
    const result = assistant('SDK final answer', Date.now());
    queueMicrotask(() => { stream.push({ type: 'start', partial: result }); stream.push({ type: 'done', reason: 'stop', message: result }); });
    return stream;
  };
  assert.ok(!fs.existsSync(statePath(sm)));
  const configBeforeCommand = fs.existsSync(configPath) && fs.readFileSync(configPath, 'utf8');
  await session.prompt('SDK first persisted user');
  assert.equal(calls, 1);
  const sdkText = fs.readFileSync(tracked(sm), 'utf8');
  assert.match(sdkText, /SDK first persisted user/); assert.match(sdkText, /SDK final answer/);
  const jsonlAfterPrompt = fs.readFileSync(sm.getSessionFile(), 'utf8');
  await session.prompt('/save-to-md');
  assert.equal(calls, 1); assert.equal(fs.readFileSync(sm.getSessionFile(), 'utf8'), jsonlAfterPrompt);
  session.setSessionName('SDK renamed');
  assert.match(tracked(sm), /SDK renamed.md$/);
  assert.ok(events.includes('turn_end')); assert.ok(events.includes('agent_settled'));
  assert.equal(fs.readFileSync(configPath, 'utf8'), configBeforeCommand);
  session.dispose();
  ok('native discovery + SDK integration: first-user timing, final turn, slash command, name, no extra inference');

  // UTC's Intl offset label is just GMT, not GMT+00:00. Preserve an explicit ISO offset.
  const utc = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { blockNetwork } from ${JSON.stringify(new URL('./host.mjs', import.meta.url).href)};
    blockNetwork();
    import { loadExtensions } from ${JSON.stringify(base + 'pi-coding-agent/dist/core/extensions/loader.js')};
    import { SessionManager } from ${JSON.stringify(base + 'pi-coding-agent/dist/index.js')};
    const loaded = await loadExtensions([${JSON.stringify(extension)}], ${JSON.stringify(root)});
    if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
    const sm = SessionManager.create(${JSON.stringify(root)}, ${JSON.stringify(join(root, 'utc-sessions'))});
    sm.appendMessage({role:'user',content:'UTC fixture',timestamp:Date.now()});
    await loaded.extensions[0].commands.get('save-to-md').handler('', {sessionManager:sm,hasUI:true,ui:{notify:(m,l)=>{if(l==='error')throw new Error(m); console.log(m)}}});
  `], { encoding: 'utf8', env: { ...process.env, PI_WORKSTATION_TIME_ZONE: 'UTC' } });
  assert.equal(utc.status, 0, utc.stderr);
  const utcFile = utc.stdout.trim().replace(/^Saved: /, '');
  assert.match(fs.readFileSync(utcFile, 'utf8'), /^created: .*[+]00:00$/m);
  ok('UTC frontmatter retains an explicit ISO zero offset');

  console.log(`\n${passed} test groups passed. All 15 requested scenarios covered. Fixtures: ${root}`);
  // Keep a representative verified export in memory/output; all test data is disposable.
  console.log('\nVerified SDK Markdown:\n' + sdkText);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
