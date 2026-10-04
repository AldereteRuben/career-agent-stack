// Manual feasibility experiment, not an account/inference adapter and not part of test:ai.
// macOS only: sandbox-exec denies external network, while an ephemeral loopback server returns fixed synthetic SSE.
// Existing HOME/CODEX_HOME are preserved. No credentials are copied and no model service is called.
// The CLI may assemble host context; the fixture inspects it only in memory and prints booleans/known markers.
// Exit 1 means this candidate did not establish isolation. Never treat a simulated answer as real inference proof.
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout, clearTimeout } from 'node:timers';
import { resolveBinary, safeCodexEnv } from './codex-capability-probe.mjs';

if (process.platform !== 'darwin') {
  console.log(JSON.stringify({ supported: false, reason: 'MACOS_SANDBOX_REQUIRED', realInference: false }));
  process.exit(2);
}
const binary = resolveBinary('codex');
if (!binary) {
  console.log(JSON.stringify({ supported: false, reason: 'CODEX_NOT_INSTALLED', realInference: false }));
  process.exit(2);
}

const directory = await mkdtemp(join(tmpdir(), 'career-mock-isolation-'));
const appServer = process.argv.includes('--app-server');
const attemptCommand = process.argv.includes('--attempt-command');
const cancelMode = process.argv.includes('--cancel');
if (cancelMode && (appServer || attemptCommand)) {
  await rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify({ realInference: false, supported: false, reason: 'CANCEL_EXEC_ONLY' }));
  process.exit(2);
}
const toolWitnessPath = join(directory, 'unexpected-tool-execution');
const report = { realInference: false, transport: 'synthetic-loopback', requests: 0, toolCount: null, personalPathPresent: null, canaryPresent: null, authHeaderPresent: false, code: null, outputEventTypes: [], stderrBytes: 0, requestBoundaries: [] };
report.candidate = appServer ? 'app-server' : 'exec';
let cancelFixture = null;
// Numeric process metadata only; never read or print command lines, environments, open files or user paths.
const processRows = () => new Promise((resolve, reject) => {
  const inspector = spawn('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat='], { stdio: ['ignore', 'pipe', 'ignore'], env: safeCodexEnv() });
  let output = '';
  inspector.stdout.on('data', chunk => { output += chunk; if (output.length > 500_000) inspector.kill('SIGKILL'); });
  inspector.on('error', () => reject(new Error('PROCESS_INSPECTION_UNAVAILABLE')));
  inspector.on('close', code => {
    if (code !== 0 || output.length > 500_000) { reject(new Error('PROCESS_INSPECTION_UNAVAILABLE')); return; }
    resolve(output.split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
      return match ? [{ pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), zombie: match[4].startsWith('Z') }] : [];
    }));
  });
});
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 2_000_000) { res.writeHead(413).end(); return; } }
  report.authHeaderPresent ||= Boolean(req.headers.authorization);
  if (report.authHeaderPresent) { res.writeHead(403).end(); return; }
  let body;
  try { body = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
  report.requests += 1;
  report.toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
  report.toolNames = (body.tools ?? []).map(tool => tool.name ?? tool.type).map(name => /^[A-Za-z0-9_]{1,80}$/.test(name) ? name : 'other');
  report.personalPathPresent = raw.includes(homedir());
  report.canaryPresent = raw.includes('CAREER_PROJECT_CANARY_9c42');
  report.personalPathFields = [];
  report.contextMarkers = [];
  report.catalogEntries = 0;
  report.homePathCategories = [];
  const walk = (value, field) => {
    if (typeof value === 'string' && value.includes(homedir())) {
      report.personalPathFields.push(field);
      report.contextMarkers = ['skills', 'AGENTS.md', 'permissions', 'sandbox', 'environment_context', 'workspace_roots', 'CODEX_HOME', 'memory', 'config.toml', 'cwd'].filter(marker => value.includes(marker));
      report.catalogEntries += (value.match(/\(file:/g) ?? []).length;
      report.homePathCategories.push(...['/.codex/skills/.system/', '/.codex/skills/', '/.agents/skills/', '/.codex/memories/'].filter(path => value.includes(homedir() + path)));
    }
    else if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${field}[${index}]`));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => walk(item, `${field}.${key}`));
  };
  walk(body, 'request');
  report.requestBoundaries.push({ tools: report.toolCount, personalPath: report.personalPathPresent, canary: report.canaryPresent, catalogEntries: report.catalogEntries });
  if (cancelMode) {
    // Keep the actual CLI waiting on the synthetic stream until its production supervisor aborts it.
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_cancel_fixture', object: 'response', status: 'in_progress', output: [] } })}\n\n`);
    res.on('close', () => { report.mockStreamClosed = true; });
    cancelFixture?.();
    return;
  }
  const functionOutputs = (body.input ?? []).filter(item => item.type === 'function_call_output');
  if (functionOutputs.length) report.toolRejected = functionOutputs.every(item => typeof item.output === 'string' && /unsupported|unknown|not available|not found|disabled|unrecognized/i.test(item.output));
  const commandArguments = JSON.stringify({ cmd: `/usr/bin/touch ${JSON.stringify(toolWitnessPath)}` });
  const isFunctionCall = attemptCommand && report.requests === 1;
  const message = isFunctionCall
    ? { id: 'fc_synthetic', type: 'function_call', call_id: 'call_synthetic', name: 'exec_command', arguments: commandArguments }
    : { id: 'msg_synthetic', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: '{"ok":true}', annotations: [] }] };
  const response = { id: 'resp_synthetic', object: 'response', status: 'completed', model: 'career-isolation-fixture', output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const event of [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: isFunctionCall ? { ...message, arguments: '' } : { ...message, status: 'in_progress', content: [] } },
    isFunctionCall
      ? { type: 'response.function_call_arguments.delta', item_id: message.id, output_index: 0, delta: commandArguments }
      : { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: '{"ok":true}' },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response },
  ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
});
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  await writeFile(join(directory, 'AGENTS.md'), 'CAREER_PROJECT_CANARY_9c42: this must never enter a model request.');
  await writeFile(join(directory, 'instructions.txt'), 'Return the supplied synthetic data as JSON. No tools or external context.');
  await writeFile(join(directory, 'schema.json'), JSON.stringify({ type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }));
  const provider = `{name="Career loopback fixture",base_url="http://127.0.0.1:${server.address().port}/v1",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0,stream_idle_timeout_ms=5000,supports_websockets=false}`;
  const config = {
    model_provider: '"career_fixture"', 'model_providers.career_fixture': provider,
    model: '"gpt-6.1-sol"', model_instructions_file: JSON.stringify(join(directory, 'instructions.txt')),
    project_doc_max_bytes: '0', developer_instructions: '""', web_search: '"disabled"',
    'memories.generate_memories': 'false', 'memories.use_memories': 'false',
    'analytics.enabled': 'false', log_dir: JSON.stringify(directory), sqlite_home: JSON.stringify(directory),
    'history.persistence': '"none"',
    'tools.experimental_request_user_input.enabled': 'false',
    'tools.update_plan.enabled': 'false',
    'skills.include_instructions': 'false', 'cloud.skills.enabled': 'false',
    suppress_unstable_features_warning: 'true',
    forced_login_method: '"chatgpt"', model_reasoning_effort: '"low"', model_reasoning_summary: '"none"',
  };
  const disabled = ['apps', 'hooks', 'plugins', 'memories', 'multi_agent', 'multi_agent_v2', 'shell_tool', 'unified_exec', 'code_mode_host', 'code_mode', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'view_image', 'skill_search', 'skill_mcp_dependency_install', 'shell_snapshot', 'tool_suggest', 'goals', 'sleep_tool', 'workspace_dependencies', 'in_app_browser', 'in_app_chat', 'in_app_local_automation', 'daemon_auto_start', 'remote_plugin', 'unbounded_connection_retries', 'system_proxy_fallback'];
  if (appServer) config.mcp_servers = '{}';
  const args = appServer ? ['--no-daemon', 'app-server', '--stdio', '--strict-config']
    : ['--no-daemon', 'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--strict-config', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '--color', 'never', '--output-schema', join(directory, 'schema.json')];
  for (const [key, value] of Object.entries(config)) args.push('-c', `${key}=${value}`);
  for (const feature of disabled) args.push('--disable', feature);
  // Explicit catalogue suppression above does not depend on experimental host discovery switches.
  if (!appServer) args.push('-');
  // OS policy forbids outbound model requests even if a managed setting overrides the loopback provider.
  const policy = `(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:${server.address().port}"))`;
  if (cancelMode) {
    // Invoke with `node --import tsx` from apps/api. This is the same supervisor used by executeCodex.
    report.stderrBytes = null; // The production supervisor deliberately does not expose provider stderr.
    const { runAiProcess } = await import('../../apps/api/src/ai/process.ts');
    const controller = new globalThis.AbortController();
    let group = null; let members = []; let requestedAt = null; let cancellationTask = null;
    cancelFixture = () => {
      if (cancellationTask) return;
      cancellationTask = (async () => {
        try {
          const before = await processRows();
          const roots = before.filter(row => row.parent === process.pid && row.group === row.pid);
          if (roots.length !== 1) { report.processInspectionFailed = true; return; }
          group = roots[0].group;
          members = before.filter(row => row.group === group);
          report.observedProcessCount = members.length;
          report.observedDescendantCount = Math.max(0, members.length - 1);
        } catch { report.processInspectionFailed = true; }
        finally { requestedAt = Date.now(); report.cancelRequested = true; controller.abort(); }
      })();
    };
    try {
      await runAiProcess({ executable: '/usr/bin/sandbox-exec', args: ['-p', policy, binary, ...args], cwd: directory,
        input: 'Return {"ok":true}. Synthetic job: QA engineer.', signal: controller.signal, timeoutMs: 15_000,
        killGraceMs: 500, maxOutputBytes: 256 * 1024, environment: safeCodexEnv(),
        onLine: line => { try { const event = JSON.parse(line); if (typeof event.type === 'string') report.outputEventTypes.push(event.type); } catch { /* no raw content */ } },
      });
      report.cancellationCode = 'UNEXPECTED_SUCCESS';
    } catch (error) { report.cancellationCode = ['AI_CANCELLED', 'AI_TIMEOUT', 'AI_PROCESS_FAILED'].includes(error.code) ? error.code : 'SUPERVISOR_FAILED'; }
    await cancellationTask;
    report.cancellationElapsedMs = requestedAt === null ? null : Date.now() - requestedAt;
    if (group !== null) {
      const deadline = Date.now() + 2_000;
      do {
        const after = await processRows();
        const remaining = after.filter(row => row.group === group || members.some(member => member.pid === row.pid));
        report.remainingProcessCount = remaining.filter(row => !row.zombie).length;
        report.remainingZombieCount = remaining.filter(row => row.zombie).length;
        if (report.remainingProcessCount === 0) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
    }
    report.cancelledCleanly = report.cancelRequested === true && report.cancellationCode === 'AI_CANCELLED'
      && !report.processInspectionFailed && report.observedProcessCount > 0 && report.remainingProcessCount === 0 && report.mockStreamClosed === true;
  } else {
  const child = spawn('/usr/bin/sandbox-exec', ['-p', policy, binary, ...args], { cwd: directory, env: safeCodexEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; let stderr = '';
  let buffered = ''; let nextId = 1;
  const pending = new Map();
  let endTurn;
  const completed = new Promise(resolve => { endTurn = resolve; });
  child.stdout.on('data', chunk => {
    if (output.length < 2_000_000) output += chunk;
    if (!appServer) return;
    buffered += chunk;
    if (buffered.length > 2_000_000) { child.kill('SIGKILL'); return; }
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (pending.has(message.id)) {
        const waiter = pending.get(message.id); pending.delete(message.id);
        if (message.error) waiter.reject(new Error('RPC_REJECTED'));
        else waiter.resolve(message.result);
      } else if (typeof message.method === 'string') {
        if (/^[a-zA-Z0-9_/]{1,100}$/.test(message.method)) report.outputEventTypes.push(message.method);
        if (message.method === 'turn/completed') endTurn();
        if (message.id !== undefined) {
          report.serverRequestedAction = true;
          child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'No tools or actions permitted' } }) + '\n');
          endTurn();
        }
      }
    }
  });
  child.stderr.on('data', chunk => { report.stderrBytes += chunk.length; if (stderr.length < 10000) stderr += chunk; });
  const timer = setTimeout(() => { endTurn(); child.kill('SIGKILL'); }, 20_000);
  child.stdin.on('error', () => {});
  const closed = new Promise(resolve => { child.on('error', () => resolve('SPAWN_ERROR')); child.on('close', resolve); });
  const rpc = (method, params) => Promise.race([
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    }),
    closed.then(() => { throw new Error('PROCESS_EXIT'); }),
  ]);
  if (appServer) {
    try {
      await rpc('initialize', { clientInfo: { name: 'career_isolation_fixture', version: '0.9.0' }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
      const thread = await rpc('thread/start', {
        model: 'gpt-6.1-sol', modelProvider: 'career_fixture', cwd: directory,
        baseInstructions: 'Return the supplied synthetic data as JSON. No tools or external context.',
        developerInstructions: '', ephemeral: true, environments: [], runtimeWorkspaceRoots: [],
        dynamicTools: [], selectedCapabilityRoots: [], sandbox: 'read-only', approvalPolicy: 'never',
      });
      report.threadStarted = typeof thread?.thread?.id === 'string';
      await rpc('turn/start', { threadId: thread.thread.id, environments: [], runtimeWorkspaceRoots: [],
        input: [{ type: 'text', text: 'Return {"ok":true}. Synthetic job: QA engineer.', text_elements: [] }],
        outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
      });
      await Promise.race([completed, closed]);
    } catch (error) { report.protocolFailure = ['RPC_REJECTED', 'PROCESS_EXIT'].includes(error.message) ? error.message : 'PROTOCOL_ERROR'; }
    child.stdin.end(); child.kill('SIGTERM');
  } else child.stdin.end('Return {"ok":true}. Synthetic job: QA engineer.');
  report.code = await closed;
  clearTimeout(timer);
  for (const line of output.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (typeof event.type === 'string') report.outputEventTypes.push(event.type);
      if (typeof event.item?.type === 'string') {
        report.outputItemTypes ??= [];
        report.outputItemTypes.push({ type: event.item.type, keys: Object.keys(event.item).filter(key => ['id', 'type', 'text', 'role', 'content', 'status', 'phase'].includes(key)), phase: ['final_answer', 'commentary'].includes(event.item.phase) ? event.item.phase : null });
        if (event.item.type === 'error') {
          const message = typeof event.item.message === 'string' ? event.item.message : '';
          report.errorMarkers ??= [];
          report.errorMarkers.push(['metadata', 'model', 'Model', 'not found', 'experimental', 'features', 'Under-development', 'unrecognized', 'sandbox', 'Ignoring', 'unknown', 'removed', 'requirements', 'configuration', 'deprecated', 'Deprecated', 'enabled', 'disabled', ...disabled].filter(marker => message.includes(marker)));
          report.expectedIsolationNotice = message === 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.';
        }
      }
    } catch { /* no raw output */ }
  }
  report.stderrHints = ['sandbox-exec', 'Operation not permitted', '--no-daemon', 'unknown field', 'unrecognized', 'unexpected argument', 'Error parsing', ...Object.keys(config), ...disabled].filter(value => stderr.includes(value));
  report.configMarkers = ['built-in', 'reserved', 'requires', 'missing field', 'name', 'override', 'Overriding', 'cannot', 'OpenAI', 'api', 'unsupported', 'not allowed', 'openai', 'request_max_retries'].filter(marker => stderr.includes(marker));
  }
  report.commandAttemptedByFixture = attemptCommand;
  report.commandWitnessCreated = await stat(toolWitnessPath).then(() => true, () => false);
  report.isolated = (cancelMode ? report.cancelledCleanly : appServer ? !report.protocolFailure && !report.serverRequestedAction : report.code === 0) && report.requests > 0
    && report.requestBoundaries.every(boundary => boundary.tools === 0 && !boundary.personalPath && !boundary.canary && boundary.catalogEntries === 0)
    && !report.authHeaderPresent && !report.commandWitnessCreated && (!attemptCommand || report.toolRejected === true);
  console.log(JSON.stringify(report));
  process.exitCode = report.isolated ? 0 : 1;
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
