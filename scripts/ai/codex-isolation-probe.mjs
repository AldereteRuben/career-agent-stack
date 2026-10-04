// Manual feasibility experiment, not an account/inference adapter and not part of test:ai.
// macOS only: sandbox-exec denies external network, while an ephemeral loopback server returns fixed synthetic SSE.
// Existing HOME/CODEX_HOME are preserved. No credentials are copied and no model service is called.
// The CLI may assemble host context; the fixture inspects it only in memory and prints booleans/known markers.
// Exit 1 means this candidate did not establish isolation. Never treat a simulated answer as real inference proof.
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
const report = { realInference: false, transport: 'synthetic-loopback', requests: 0, toolCount: null, personalPathPresent: null, canaryPresent: null, authHeaderPresent: false, code: null, outputEventTypes: [], stderrBytes: 0 };
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
  const walk = (value, field) => {
    if (typeof value === 'string' && value.includes(homedir())) {
      report.personalPathFields.push(field);
      report.contextMarkers = ['skills', 'AGENTS.md', 'permissions', 'sandbox', 'environment_context', 'workspace_roots', 'CODEX_HOME', 'memory', 'config.toml', 'cwd'].filter(marker => value.includes(marker));
    }
    else if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${field}[${index}]`));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => walk(item, `${field}.${key}`));
  };
  walk(body, 'request');
  const message = { id: 'msg_synthetic', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: '{"ok":true}', annotations: [] }] };
  const response = { id: 'resp_synthetic', object: 'response', status: 'completed', model: 'career-isolation-fixture', output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const event of [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: '{"ok":true}' },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response },
  ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  await writeFile(join(directory, 'AGENTS.md'), 'CAREER_PROJECT_CANARY_9c42: this must never enter a model request.');
  await writeFile(join(directory, 'instructions.txt'), 'Return the supplied synthetic data as JSON. No tools or external context.');
  await writeFile(join(directory, 'schema.json'), JSON.stringify({ type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }));
  const provider = `{name="Career loopback fixture",base_url="http://127.0.0.1:${server.address().port}/v1",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0,stream_idle_timeout_ms=5000,supports_websockets=false}`;
  const config = {
    model_provider: '"career_fixture"', 'model_providers.career_fixture': provider,
    model: '"career-isolation-fixture"', model_instructions_file: JSON.stringify(join(directory, 'instructions.txt')),
    project_doc_max_bytes: '0', developer_instructions: '""', web_search: '"disabled"',
    'memories.generate_memories': 'false', 'memories.use_memories': 'false',
    'analytics.enabled': 'false', log_dir: JSON.stringify(directory), sqlite_home: JSON.stringify(directory),
    'history.persistence': '"none"',
  };
  const disabled = ['apps', 'hooks', 'plugins', 'memories', 'multi_agent', 'multi_agent_v2', 'shell_tool', 'unified_exec', 'code_mode_host', 'code_mode', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'view_image', 'skill_search', 'skill_mcp_dependency_install', 'shell_snapshot', 'tool_suggest', 'goals', 'sleep_tool', 'workspace_dependencies', 'in_app_browser', 'in_app_chat', 'in_app_local_automation', 'daemon_auto_start', 'remote_plugin', 'unbounded_connection_retries', 'system_proxy_fallback'];
  const args = ['--no-daemon', 'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--strict-config', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '--color', 'never', '--output-schema', join(directory, 'schema.json')];
  for (const [key, value] of Object.entries(config)) args.push('-c', `${key}=${value}`);
  for (const feature of disabled) args.push('--disable', feature);
  args.push('--enable', 'skip_host_skill_discovery', '-');
  // OS policy forbids outbound model requests even if a managed setting overrides the loopback provider.
  const policy = `(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:${server.address().port}"))`;
  const child = spawn('/usr/bin/sandbox-exec', ['-p', policy, binary, ...args], { cwd: directory, env: safeCodexEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; let stderr = '';
  child.stdout.on('data', chunk => { if (output.length < 2_000_000) output += chunk; });
  child.stderr.on('data', chunk => { report.stderrBytes += chunk.length; if (stderr.length < 10000) stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  child.stdin.on('error', () => {});
  child.stdin.end('Return {"ok":true}. Synthetic job: QA engineer.');
  report.code = await new Promise(resolve => { child.on('error', () => resolve('SPAWN_ERROR')); child.on('close', resolve); });
  clearTimeout(timer);
  for (const line of output.split('\n')) {
    try { const event = JSON.parse(line); if (typeof event.type === 'string') report.outputEventTypes.push(event.type); } catch { /* no raw output */ }
  }
  report.stderrHints = ['sandbox-exec', 'Operation not permitted', '--no-daemon', 'unknown field', 'unrecognized', 'unexpected argument', 'Error parsing', ...Object.keys(config), ...disabled].filter(value => stderr.includes(value));
  report.isolated = report.code === 0 && report.requests > 0 && report.toolCount === 0 && report.personalPathPresent === false && report.canaryPresent === false && !report.authHeaderPresent;
  console.log(JSON.stringify(report));
  process.exitCode = report.isolated ? 0 : 1;
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
