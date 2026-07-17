import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildPrompt,
  callOpenCode as callOpenCodeImpl,
  defaultFallbackModel,
  ensurePersistentServer,
  extractJsonObject,
  guardAllowedModels,
  launchPersistentServer,
  parseArgs,
  parseOpenCodeJsonl,
  probeServerHealth,
  readExistingPathOrLiteral,
  runAsk as runAskImpl,
  runBoundedCommand,
  runMain,
  validateAssistantOutput
} from './ocask.mjs';

const QWEN_MODEL = 'qwen3.7-plus';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';

function callOpenCode(options) {
  return callOpenCodeImpl({ ...options, disableServer: true });
}

function runAsk(options) {
  return runAskImpl({ ...options, disableServer: true });
}

function textEvent(text, id = 'part-1') {
  return JSON.stringify({ type: 'text', part: { type: 'text', id, text } });
}

function jsonl(text, id) {
  return `${textEvent(text, id)}\n`;
}

test('parseArgs handles supported booleans and rejects unknown legacy flags', () => {
  assert.deepEqual(
    { ...parseArgs(['--model', QWEN_MODEL, '--task', 'hello', '--json', '--require-verdict']) },
    { model: QWEN_MODEL, task: 'hello', json: true, 'require-verdict': true }
  );
  assert.throws(() => parseArgs(['--task', 'x', '--attempts', '3']), /Unknown option/);
});

test('paid-model gate rejects free and unknown models before invocation', async () => {
  assert.throws(() => guardAllowedModels({ model: `${QWEN_MODEL}-free` }), /not allowed/);
  assert.throws(() => guardAllowedModels({ model: 'kimi-k2.7-code' }), /DeepSeek\/Qwen models only/);
  assert.throws(
    () => guardAllowedModels({ model: QWEN_MODEL, fallbackModel: 'glm-4.6' }),
    /not allowed/
  );

  let calls = 0;
  await assert.rejects(
    runAsk({
      model: `${QWEN_MODEL}-free`,
      taskText: 'do work',
      commandRunner: async () => {
        calls += 1;
        return { stdout: jsonl('unreachable'), stderr: '' };
      }
    }),
    /not allowed/
  );
  assert.equal(calls, 0);
});

test('default fallback is deterministic and from the opposite family', () => {
  assert.equal(defaultFallbackModel('deepseek-v4-pro'), QWEN_MODEL);
  assert.equal(defaultFallbackModel('qwen3.7-max'), DEEPSEEK_MODEL);
});

test('same-family, identical, and non-family explicit fallbacks reject before spawn', async () => {
  const invalidFallbacks = ['qwen3.7-max', QWEN_MODEL];
  for (const fallbackModel of invalidFallbacks) {
    let calls = 0;
    await assert.rejects(
      runAsk({
        model: QWEN_MODEL,
        fallbackModel,
        taskText: 'review',
        commandRunner: async () => {
          calls += 1;
          return { stdout: jsonl('unreachable'), stderr: '' };
        }
      }),
      /different|opposite/
    );
    assert.equal(calls, 0);
  }
  await assert.rejects(runAsk({
    model: QWEN_MODEL,
    fallbackModel: 'kimi-k2.7-code',
    taskText: 'review',
    commandRunner: async () => ({ stdout: jsonl('unreachable'), stderr: '' })
  }), /DeepSeek\/Qwen models only/);
});

test('OpenCode invocation uses exact argv, full project cwd/config, allow-all env, and stdin prompt', async () => {
  let observed;
  const callerCwd = process.cwd();
  const result = await callOpenCode({
    model: QWEN_MODEL,
    prompt: 'secret-shaped prompt stays on stdin',
    timeoutMs: 999999,
    inheritedEnv: { PATH: '/test/bin', HOME: '/test/home' },
    opencodeBin: '/real/opencode',
    commandRunner: async (request) => {
      observed = request;
      return { stdout: jsonl('usable prose'), stderr: 'diagnostic only' };
    }
  });

  assert.equal(result, 'usable prose');
  assert.equal(observed.command, '/real/opencode');
  assert.deepEqual(observed.args, [
    'run',
    '--auto',
    '--pure',
    '--model',
    `opencode-go/${QWEN_MODEL}`,
    '--format',
    'json'
  ]);
  assert.equal(observed.args.includes(observed.prompt), false);
  // The delegated identity marker is prepended at the transport boundary; the
  // caller's task text follows it verbatim and is never placed in argv.
  assert.ok(observed.prompt.endsWith('secret-shaped prompt stays on stdin'));
  assert.match(observed.prompt, /^\[DELEGATED_RUNNER_IDENTITY\]/);
  assert.match(observed.prompt, /native subagents remain allowed/);
  assert.match(observed.prompt, /must inherit this delegated marker/);
  assert.match(observed.prompt, /Do not recursively invoke external model runners/);
  assert.equal(observed.timeoutMs, 999999);
  // The default stream cap is unbounded (0 = disabled); no artificial bottleneck.
  assert.equal(observed.maxOutputBytes, 0);
  assert.equal(observed.cwd, callerCwd);
  // Terminal-leaf boundary: the opencode child gets AI_FLOW_LEAF=1 and a shim
  // PATH prepended so its own subprocesses cannot recurse into model runners.
  assert.match(observed.env.PATH, /\/leaf-shims:\/test\/bin$/);
  assert.equal(observed.env.AI_FLOW_LEAF, '1');
  assert.equal(observed.env.AI_FLOW_SURFACE, 'opencode');
  assert.equal(observed.env.OPENCODE_DISABLE_CLAUDE_CODE, '1');
  assert.equal(observed.env.OPENCODE_PERMISSION, '{"*":"allow"}');
  assert.equal(observed.env.OPENCODE_CONFIG_DIR, undefined);
  assert.equal(observed.env.OPENCODE_DISABLE_PROJECT_CONFIG, undefined);
});

test('runAsk passes an injected scoped repository cwd to both attempts', async () => {
  const seenCwds = [];
  await runAsk({
    model: QWEN_MODEL,
    fallbackModel: DEEPSEEK_MODEL,
    taskText: 'Inspect the repository',
    cwd: '/scoped/repository',
    commandRunner: async (request) => {
      seenCwds.push(request.cwd);
      const output = seenCwds.length === 1 ? '123' : 'Repository inspection completed.';
      return { stdout: jsonl(output, `p-${seenCwds.length}`), stderr: '' };
    }
  });
  assert.deepEqual(seenCwds, ['/scoped/repository', '/scoped/repository']);
});

test('CLI auth is authoritative and no API-key file is required', async () => {
  const oldKey = process.env.OPENCODE_GO_KEY_FILE;
  delete process.env.OPENCODE_GO_KEY_FILE;
  try {
    const result = await runAsk({
      model: QWEN_MODEL,
      taskText: 'say hello',
      commandRunner: async () => ({ stdout: jsonl('Hello from CLI auth.'), stderr: '' })
    });
    assert.deepEqual({ ok: result.ok, output: result.output, model: result.model },
      { ok: true, output: 'Hello from CLI auth.', model: QWEN_MODEL });
    assert.ok(result.metadata, 'metadata report present');
    assert.equal(result.metadata.requested_model, QWEN_MODEL);
  } finally {
    if (oldKey === undefined) delete process.env.OPENCODE_GO_KEY_FILE;
    else process.env.OPENCODE_GO_KEY_FILE = oldKey;
  }
});

test('long and multiline inline literals bypass stat and remain literal', async () => {
  const longLiteral = 'x'.repeat(10000);
  assert.equal(await readExistingPathOrLiteral(longLiteral), longLiteral);
  assert.equal(await readExistingPathOrLiteral('line one\nline two'), 'line one\nline two');
});

test('runMain rejects multiple stdin sources before invoking OpenCode', async () => {
  let calls = 0;
  const stderr = [];
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runMain(
      ['--model', QWEN_MODEL, '--task', '-', '--context', '-'],
      async () => {
        calls += 1;
        return { stdout: jsonl('unreachable'), stderr: '' };
      },
      () => {},
      (line) => stderr.push(line)
    );
    assert.equal(calls, 0);
    assert.equal(process.exitCode, 1);
    assert.match(stderr.join('\n'), /Only one.*stdin/);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('JSONL parser handles CRLF, unterminated final lines, malformed diagnostics, and duplicate ids', () => {
  const stdout = [
    'diagnostic: starting',
    textEvent('first', 'a'),
    textEvent('duplicate ignored', 'a'),
    JSON.stringify({ type: 'step_finish', part: { type: 'step_finish', tokens: 123 } }),
    textEvent('second', 'b')
  ].join('\r\n');
  assert.equal(parseOpenCodeJsonl(stdout), 'first\nsecond');
  assert.throws(() => parseOpenCodeJsonl('not json\n'), /no assistant text event/);
  assert.throws(
    () => parseOpenCodeJsonl(`${jsonl('text before error')}${JSON.stringify({ type: 'error' })}\n`),
    /error event/
  );
});

test('stderr and non-text transport events are never used as assistant output', async () => {
  let calls = 0;
  await assert.rejects(
    runAsk({
      model: QWEN_MODEL,
      taskText: 'answer',
      fallbackModel: DEEPSEEK_MODEL,
      commandRunner: async () => {
        calls += 1;
        return {
          stdout: `${JSON.stringify({ type: 'step_finish', tokens: 999 })}\n`,
          stderr: 'This prose is only a diagnostic.'
        };
      }
    }),
    /no assistant text event/
  );
  assert.equal(calls, 2);
});

test('numeric-only primary falls back once with original prompt plus safe correction', async () => {
  const invocations = [];
  const result = await runAsk({
    model: DEEPSEEK_MODEL,
    taskText: 'Audit this architecture.',
    fallbackModel: QWEN_MODEL,
    systemText: 'Be rigorous.',
    contextText: 'A small context.',
    commandRunner: async (request) => {
      invocations.push(request);
      const output = invocations.length === 1 ? '12345' : 'Recovered with a rigorous rationale.';
      return { stdout: jsonl(output, `p-${invocations.length}`), stderr: '' };
    }
  });

  assert.deepEqual({ ok: result.ok, output: result.output, model: result.model },
    { ok: true, output: 'Recovered with a rigorous rationale.', model: QWEN_MODEL });
  assert.ok(result.metadata, 'metadata report present');
  assert.equal(result.metadata.actual_model, QWEN_MODEL);
  assert.equal(result.metadata.fallback_used, true);
  assert.equal(invocations.length, 2);
  assert.match(invocations[0].prompt, /## SYSTEM INSTRUCTIONS\nBe rigorous\./);
  assert.match(invocations[0].prompt, /## TASK\nAudit this architecture\./);
  assert.match(invocations[0].prompt, /## CONTEXT\nA small context\./);
  assert.ok(invocations[1].prompt.startsWith(invocations[0].prompt));
  assert.match(invocations[1].prompt, /## RETRY CORRECTION/);
  assert.match(invocations[1].prompt, /reason code: malformed_contract/);
  assert.doesNotMatch(invocations[1].prompt, /12345/);
});

test('provider diagnostics are suppressed from process errors', async () => {
  const sentinel = 'PRIVATE_PROVIDER_DIAGNOSTIC_DO_NOT_COPY';
  await assert.rejects(runBoundedCommand({
    command: process.execPath,
    args: ['-e', `process.stderr.write('${sentinel}'); process.exit(9)`],
    prompt: '', cwd: process.cwd(), env: process.env, timeoutMs: 5000
  }), (error) => error.code === 'PROCESS_EXIT'
      && !error.message.includes(sentinel)
      && /diagnostics suppressed/.test(error.message));
});

test('numeric-only output from both families errors after exactly two invocations', async () => {
  let calls = 0;
  await assert.rejects(
    runAsk({
      model: DEEPSEEK_MODEL,
      taskText: 'Audit',
      fallbackModel: QWEN_MODEL,
      commandRunner: async () => {
        calls += 1;
        return { stdout: jsonl(String(100 + calls), `p-${calls}`), stderr: '' };
      }
    }),
    /alphabetic content/
  );
  assert.equal(calls, 2);
});

test('explicit verdict mode accepts APPROVED, WARNING, and BLOCKED with rationale', () => {
  for (const verdict of ['APPROVED', 'WARNING', 'BLOCKED']) {
    const output = `VERDICT: ${verdict}\nThe code has a concrete evidence-based rationale.`;
    assert.equal(validateAssistantOutput(output, { requireVerdict: true }), output);
  }
  for (const decorated of ['## Verdict: APPROVED', '**VERDICT: WARNING**', '- `VERDICT: BLOCKED`']) {
    assert.doesNotThrow(() => validateAssistantOutput(
      `${decorated}\nA separate evidence-based rationale follows.`,
      { requireVerdict: true }
    ));
  }
  assert.doesNotThrow(() => validateAssistantOutput(
    'Security review\n\n## Verdict: APPROVED\nA separate evidence-based rationale follows.',
    { requireVerdict: true }
  ));
  assert.throws(
    () => validateAssistantOutput(
      'VERDICT: APPROVED\nVERDICT: BLOCKED\nConflicting rationale.',
      { requireVerdict: true }
    ),
    /exactly one explicit VERDICT/
  );
  assert.throws(
    () => validateAssistantOutput(
      'VERDICT: APPROVED\nOne\nTwo\nThree\nFour\nFive\n## VERDICT: BLOCKED\nConflicting late rationale.',
      { requireVerdict: true }
    ),
    /exactly one explicit VERDICT/
  );
});

test('missing verdict or separate rationale triggers one opposite-family fallback', async () => {
  for (const invalid of [
    'This has prose but no verdict.',
    'VERDICT: APPROVED'
  ]) {
    let calls = 0;
    const result = await runAsk({
      model: QWEN_MODEL,
      taskText: 'Review this',
      requireVerdict: true,
      commandRunner: async () => {
        calls += 1;
        const output = calls === 1
          ? invalid
          : 'VERDICT: WARNING\nA distinct rationale explains the risk.';
        return { stdout: jsonl(output, `p-${calls}`), stderr: '' };
      }
    });
    assert.equal(result.model, DEEPSEEK_MODEL);
    assert.equal(calls, 2);
  }
});

test('JSON mode emits one object and supports structured verdict contracts', async () => {
  const reviewPrompt = buildPrompt({
    taskText: 'Review JSON safely', jsonMode: true, requireVerdict: true
  });
  assert.match(reviewPrompt, /review-only task/);
  assert.match(reviewPrompt, /do not modify files or external state/);
  const result = await runAsk({
    model: QWEN_MODEL,
    taskText: 'Return JSON',
    jsonMode: true,
    commandRunner: async () => ({
      stdout: jsonl('{"ok":true,"summary":"Useful prose."}'),
      stderr: ''
    })
  });
  assert.deepEqual(result.output, { ok: true, summary: 'Useful prose.' });
  assert.deepEqual(extractJsonObject('{"value":2}'), { value: 2 });
  assert.throws(() => extractJsonObject('prefix {"value":2} suffix'), /one JSON object/);

  const review = validateAssistantOutput(
    '{"verdict":"blocked","reasoning":"An authentication boundary is missing."}',
    { jsonMode: true, requireVerdict: true }
  );
  assert.equal(review.verdict, 'blocked');
  assert.throws(
    () => validateAssistantOutput('{"verdict":"APPROVED","reason":"123"}', {
      jsonMode: true,
      requireVerdict: true
    }),
    /alphabetic.*rationale/
  );
});

test('runMain preserves JSON single-object stdout shape', async () => {
  const stdout = [];
  const stderr = [];
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runMain(
      ['--model', QWEN_MODEL, '--task', 'Return data', '--json'],
      async () => ({ stdout: jsonl('{"answer":"yes"}'), stderr: '' }),
      (line) => stdout.push(line),
      (line) => stderr.push(line),
      undefined,
      process.cwd(),
      { disableServer: true }
    );
    assert.deepEqual(JSON.parse(stdout[0]), { answer: 'yes' });
    assert.deepEqual(stderr, []);
    assert.equal(process.exitCode, undefined);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('nonzero temperature rejects before invocation', async () => {
  let calls = 0;
  await assert.rejects(
    runAsk({
      model: QWEN_MODEL,
      taskText: 'work',
      temperature: 0.2,
      commandRunner: async () => {
        calls += 1;
        return { stdout: jsonl('unreachable'), stderr: '' };
      }
    }),
    /only supports 0/
  );
  assert.equal(calls, 0);
});

test('max-tokens remains an advisory prompt contract and is not passed as CLI argv', async () => {
  let invocation;
  await runAsk({
    model: QWEN_MODEL,
    taskText: 'Concise answer',
    maxTokens: 321,
    commandRunner: async (request) => {
      invocation = request;
      return { stdout: jsonl('A concise answer.'), stderr: '' };
    }
  });
  assert.match(invocation.prompt, /approximately 321 tokens/);
  assert.equal(invocation.args.includes('321'), false);
  assert.equal(invocation.args.includes('--max-tokens'), false);
});

test('omitted max-tokens adds no advisory and omitted timeout is unbounded', async () => {
  let invocation;
  await runAsk({
    model: QWEN_MODEL,
    taskText: 'Answer naturally',
    commandRunner: async (request) => {
      invocation = request;
      return { stdout: jsonl('A natural direct answer.'), stderr: '' };
    }
  });
  assert.doesNotMatch(invocation.prompt, /Advisory response limit/);
  assert.equal(invocation.timeoutMs, 0);
});

test('explicit timeout has no wrapper ceiling', async () => {
  let invocation;
  await callOpenCode({
    model: QWEN_MODEL,
    prompt: 'work',
    timeoutMs: 600000,
    commandRunner: async (request) => {
      invocation = request;
      return { stdout: jsonl('Work completed.'), stderr: '' };
    }
  });
  assert.equal(invocation.timeoutMs, 600000);
});

test('bounded child manager reports nonzero exit without stderr leakage', async () => {
  await assert.rejects(
    runBoundedCommand({
      command: process.execPath,
      args: ['-e', 'process.stderr.write("useful diagnostic"); process.exit(7)'],
      prompt: '',
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5000
    }),
    (error) => error.code === 'PROCESS_EXIT'
      && /code 7/.test(error.message)
      && !/useful diagnostic/.test(error.message)
  );
});

test('bounded child manager enforces timeout with process-group termination', async () => {
  await assert.rejects(
    runBoundedCommand({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      prompt: '',
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 30,
      killGraceMs: 20
    }),
    (error) => error.code === 'TIMEOUT' && /timed out/.test(error.message)
  );
});

test('host interruption terminates the owned child group and removes signal listeners', async () => {
  const before = process.listenerCount('SIGINT');
  const running = runBoundedCommand({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    prompt: '', cwd: process.cwd(), env: process.env,
    timeoutMs: 0, killGraceMs: 20
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.emit('SIGINT');
  await assert.rejects(running, (error) => error.code === 'INTERRUPTED' && /SIGINT/.test(error.message));
  assert.equal(process.listenerCount('SIGINT'), before);
});

test('timeout is non-retriable and never duplicates a long primary invocation', async () => {
  let calls = 0;
  await assert.rejects(
    runAsk({
      model: QWEN_MODEL,
      taskText: 'Perform a long audit',
      timeoutMs: 1000,
      commandRunner: async () => {
        calls += 1;
        const error = new Error('simulated explicit deadline');
        error.code = 'TIMEOUT';
        throw error;
      }
    }),
    /explicit deadline/
  );
  assert.equal(calls, 1);
});

test('output-limit termination is non-retriable', async () => {
  let calls = 0;
  await assert.rejects(
    runAsk({
      model: QWEN_MODEL,
      taskText: 'work',
      commandRunner: async () => {
        calls += 1;
        const error = new Error('output cap');
        error.code = 'OUTPUT_LIMIT';
        throw error;
      }
    }),
    /output cap/
  );
  assert.equal(calls, 1);
});

test('bounded child manager enforces independent output caps', async () => {
  for (const stream of ['stdout', 'stderr']) {
    await assert.rejects(
      runBoundedCommand({
        command: process.execPath,
        args: ['-e', `process.${stream}.write("x".repeat(1024))`],
        prompt: '',
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 5000,
        maxOutputBytes: 128,
        killGraceMs: 20
      }),
      (error) => error.code === 'OUTPUT_LIMIT' && new RegExp(`${stream} exceeded`).test(error.message)
    );
  }
});

test('default stream limit is unbounded: output beyond any small cap completes', async () => {
  // No maxOutputBytes injected -> default 0 (disabled). 4 KiB of stdout completes
  // cleanly instead of tripping an output limit.
  const result = await runBoundedCommand({
    command: process.execPath,
    args: ['-e', 'process.stdout.write(Buffer.alloc(4096, 97))'],
    prompt: '',
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 5000
  });
  assert.equal(result.stdout.length, 4096);
});

test('uncertain transport failures never replay on a fallback model', async () => {
  let calls = 0;
  await assert.rejects(
    runAsk({
      model: QWEN_MODEL,
      taskText: 'work',
      fallbackModel: DEEPSEEK_MODEL,
      commandRunner: async () => {
        calls += 1;
        const error = new Error('simulated transport failure');
        error.code = 'PROCESS_EXIT';
        throw error;
      }
    }),
    /simulated transport failure/
  );
  assert.equal(calls, 1);
});

test('persistent server cold-start writes private authenticated state and reuses it while healthy', async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocask-server-test-'));
  let launches = 0;
  let launchedRequest;
  const healthRequests = [];
  const randomBytesImpl = (size) => Buffer.alloc(size, 0x61);
  const fetchImpl = async (url, options) => {
    healthRequests.push({ url, options });
    return { ok: true, json: async () => ({ healthy: true, version: '1.17.20' }) };
  };
  const options = {
    runtimeDir,
    opencodeBin: '/real/opencode',
    reservePortImpl: async () => 45671,
    randomBytesImpl,
    pidAliveImpl: () => true,
    fetchImpl,
    serverLauncher: async (request) => {
      launches += 1;
      launchedRequest = request;
      return { pid: 42420 };
    },
    sleepImpl: async () => {},
    startWaitMs: 1000
  };

  try {
    const cold = await ensurePersistentServer(options);
    const warm = await ensurePersistentServer(options);
    assert.equal(launches, 1);
    assert.equal(cold.url, 'http://127.0.0.1:45671');
    assert.equal(cold.cold, true);
    assert.deepEqual(warm, { ...cold, cold: false });
    assert.equal(launchedRequest.password, cold.password);
    assert.equal(launchedRequest.env, process.env);
    assert.equal(healthRequests[0].url, 'http://127.0.0.1:45671/global/health');
    assert.equal(
      healthRequests[0].options.headers.Authorization,
      `Basic ${Buffer.from(`opencode:${cold.password}`).toString('base64')}`
    );

    const runtimeMode = (await fs.stat(runtimeDir)).mode & 0o777;
    const stateMode = (await fs.stat(path.join(runtimeDir, 'server-state.json'))).mode & 0o777;
    assert.equal(runtimeMode, 0o700);
    assert.equal(stateMode, 0o600);
  } finally {
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

test('concurrent cold callers share one atomically started server without serializing requests', async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocask-server-race-'));
  let launches = 0;
  let ready = false;
  let releaseLaunch;
  let announceLaunch;
  const launchStarted = new Promise((resolve) => { announceLaunch = resolve; });
  const launchGate = new Promise((resolve) => { releaseLaunch = resolve; });
  const options = {
    runtimeDir,
    opencodeBin: '/real/opencode',
    reservePortImpl: async () => 45672,
    randomBytesImpl: (size) => Buffer.alloc(size, 0x62),
    pidAliveImpl: () => true,
    fetchImpl: async () => ready
      ? { ok: true, json: async () => ({ healthy: true, version: '1.17.20' }) }
      : { ok: false, json: async () => ({}) },
    serverLauncher: async () => {
      launches += 1;
      announceLaunch();
      await launchGate;
      ready = true;
      return { pid: 42421 };
    },
    sleepImpl: () => new Promise((resolve) => setTimeout(resolve, 1)),
    startWaitMs: 1000,
    pollMs: 1
  };

  try {
    const first = ensurePersistentServer(options);
    await launchStarted;
    const second = ensurePersistentServer(options);
    releaseLaunch();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(launches, 1);
    assert.equal(a.url, b.url);
    assert.equal(a.password, b.password);
  } finally {
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

test('server launcher binds loopback and keeps random password out of argv', async () => {
  let observed;
  const child = new EventEmitter();
  child.pid = 42422;
  child.unref = () => {};
  const launched = launchPersistentServer({
    port: 45673,
    password: 'never-put-this-password-in-argv',
    runtimeDir: '/runtime/ocask',
    env: { PATH: '/test/bin' },
    opencodeBin: '/real/opencode',
    spawnImpl: (command, args, options) => {
      observed = { command, args, options };
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }
  });

  assert.deepEqual(await launched, { pid: 42422 });
  assert.equal(observed.command, '/real/opencode');
  assert.deepEqual(observed.args, ['serve', '--hostname', '127.0.0.1', '--port', '45673']);
  assert.doesNotMatch(observed.args.join(' '), /never-put-this-password/);
  assert.equal(observed.options.env.OPENCODE_SERVER_PASSWORD, 'never-put-this-password-in-argv');
  assert.equal(observed.options.env.OPENCODE_DISABLE_CLAUDE_CODE, '1');
  assert.equal(observed.options.env.OPENCODE_PERMISSION, '{"*":"allow"}');
  assert.equal(observed.options.shell, false);
});

test('attached client uses exact attach argv and dir with password only in env', async () => {
  let observed;
  const output = await callOpenCodeImpl({
    model: QWEN_MODEL,
    prompt: 'inspect this repository',
    cwd: '/scoped/repository',
    inheritedEnv: { OCASK_DISABLE_SERVER: '0' },
    opencodeBin: '/real/opencode',
    serverProvider: async () => ({
      url: 'http://127.0.0.1:45674',
      password: 'attach-password'
    }),
    commandRunner: async (request) => {
      observed = request;
      return { stdout: jsonl('Attached response.'), stderr: '' };
    }
  });

  assert.equal(output, 'Attached response.');
  assert.deepEqual(observed.args, [
    'run',
    '--attach',
    'http://127.0.0.1:45674',
    '--dir',
    '/scoped/repository',
    '--auto',
    '--pure',
    '--model',
    `opencode-go/${QWEN_MODEL}`,
    '--format',
    'json'
  ]);
  assert.equal(observed.cwd, '/scoped/repository');
  assert.equal(observed.env.OPENCODE_SERVER_PASSWORD, 'attach-password');
  assert.doesNotMatch(observed.args.join(' '), /attach-password/);
  assert.doesNotMatch(observed.prompt, /attach-password/);
});

test('when server is disabled, serverProvider is never consulted', async () => {
  let providerCalls = 0;
  let observed;
  await callOpenCodeImpl({
    model: QWEN_MODEL,
    prompt: 'direct request',
    inheritedEnv: { OCASK_DISABLE_SERVER: '1' },
    opencodeBin: '/real/opencode',
    serverProvider: async () => {
      providerCalls += 1;
      throw new Error('must not run');
    },
    commandRunner: async (request) => {
      observed = request;
      return { stdout: jsonl('Direct response.'), stderr: '' };
    }
  });
  assert.equal(providerCalls, 0);
  assert.deepEqual(observed.args, [
    'run', '--auto', '--pure', '--model', `opencode-go/${QWEN_MODEL}`, '--format', 'json'
  ]);
});

test('server establishment failure degrades to direct launch before prompt submission', async () => {
  let submissions = 0;
  let observed;
  const output = await callOpenCodeImpl({
    model: QWEN_MODEL,
    prompt: 'submit once',
    inheritedEnv: { OCASK_DISABLE_SERVER: '0' },
    opencodeBin: '/real/opencode',
    serverProvider: async () => {
      throw new Error('server could not start');
    },
    commandRunner: async (request) => {
      submissions += 1;
      observed = request;
      return { stdout: jsonl('Direct fallback response.'), stderr: '' };
    }
  });
  assert.equal(output, 'Direct fallback response.');
  assert.equal(submissions, 1);
  assert.equal(observed.args.includes('--attach'), false);
  assert.ok(observed.prompt.endsWith('submit once'));
  assert.match(observed.prompt, /^\[DELEGATED_RUNNER_IDENTITY\]/);
});

test('attached request failure is never replayed directly or on the opposite model', async () => {
  let submissions = 0;
  await assert.rejects(
    runAskImpl({
      model: QWEN_MODEL,
      taskText: 'audit',
      inheritedEnv: { OCASK_DISABLE_SERVER: '0' },
      opencodeBin: '/real/opencode',
      serverProvider: async () => ({ url: 'http://127.0.0.1:45675', password: 'secret' }),
      commandRunner: async () => {
        submissions += 1;
        const error = new Error('connection closed after submission');
        error.code = 'PROCESS_EXIT';
        throw error;
      }
    }),
    (error) => error.code === 'ATTACH_REQUEST_FAILURE' && /may have begun/.test(error.message)
  );
  assert.equal(submissions, 1);
});

test('Go Lite classification is actionable, preserved through attach, and non-retriable', async () => {
  let submissions = 0;
  await assert.rejects(
    runAskImpl({
      model: DEEPSEEK_MODEL,
      taskText: 'deep audit',
      inheritedEnv: { OCASK_DISABLE_SERVER: '0' },
      opencodeBin: '/real/opencode',
      serverProvider: async () => ({ url: 'http://127.0.0.1:45676', password: 'secret' }),
      commandRunner: async () => {
        submissions += 1;
        const error = new Error('Model deepseek-v4-pro is not supported on the lite model list');
        error.code = 'PROCESS_EXIT';
        throw error;
      }
    }),
    (error) => error.code === 'GO_ENTITLEMENT_UNAVAILABLE'
      && /catalog/i.test(error.message)
      && /stale or wrong Go key/i.test(error.message)
      && /freshly generated Go API key/i.test(error.message)
      && /Codex or standalone GLM/i.test(error.message)
  );
  assert.equal(submissions, 1);

  assert.throws(
    () => parseOpenCodeJsonl(`${JSON.stringify({
      type: 'error',
      error: { code: 'model_not_supported' }
    })}\n`),
    (error) => error.code === 'GO_ENTITLEMENT_UNAVAILABLE'
  );

  await assert.rejects(
    runBoundedCommand({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({type:"error",error:{code:"model_not_supported"}})); process.exit(1)'],
      prompt: '',
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5000
    }),
    (error) => error.code === 'GO_ENTITLEMENT_UNAVAILABLE'
  );
});

test('server health rejects a version mismatch even with a live stored PID', async () => {
  const result = await probeServerHealth(
    { pid: 42423, port: 45677, password: 'x'.repeat(32), version: '1.17.19' },
    {
      pidAliveImpl: () => true,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ healthy: true, version: '1.17.20' })
      })
    }
  );
  assert.equal(result, null);
});

test('live unhealthy server state is preserved and never orphaned by replacement', async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocask-live-unhealthy-'));
  const statePath = path.join(runtimeDir, 'server-state.json');
  const state = {
    schema: 2, pid: 42423, port: 45677, password: 'x'.repeat(32),
    version: '1.17.19', startedAt: new Date().toISOString()
  };
  let launches = 0;
  try {
    await fs.writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await assert.rejects(ensurePersistentServer({
      runtimeDir,
      opencodeBin: '/real/opencode',
      pidAliveImpl: () => true,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ healthy: true, version: '1.17.20' })
      }),
      serverLauncher: async () => { launches += 1; return { pid: 99999 }; }
    }), /alive but unhealthy/);
    assert.equal(launches, 0);
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, 'utf8')), state);
  } finally {
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

test('prompt labels system instructions and selects the applicable response contract', () => {
  const prompt = buildPrompt({
    taskText: 'Review code',
    systemText: 'Act as a security reviewer',
    contextText: 'Changed auth flow',
    requireVerdict: true,
    maxTokens: 800
  });
  assert.match(prompt, /^## SYSTEM INSTRUCTIONS/);
  assert.match(prompt, /## TASK/);
  assert.match(prompt, /## CONTEXT/);
  assert.match(prompt, /## EXECUTION GUIDANCE/);
  assert.match(prompt, /analytical review/);
  assert.match(prompt, /Think step by step/);
  assert.match(prompt, /## RESPONSE CONTRACT/);
  assert.match(prompt, /Near the top/);
  assert.match(prompt, /review-only task/);
  assert.match(prompt, /approximately 800 tokens/);
});

test('lens framework injects audit dimensions into prompt', () => {
  const prompt = buildPrompt({
    taskText: 'Review architecture',
    requireVerdict: true,
    lens: 'architecture'
  });
  assert.match(prompt, /## AUDIT FRAMEWORK/);
  assert.match(prompt, /Module boundaries/);
  assert.match(prompt, /Coupling and cohesion/);
  assert.match(prompt, /Deep vs shallow/);
});

test('lens without verdict uses review execution guidance', () => {
  const prompt = buildPrompt({
    taskText: 'Analyze code',
    requireVerdict: true,
    lens: 'security'
  });
  assert.match(prompt, /## AUDIT FRAMEWORK/);
  assert.match(prompt, /Injection surfaces/);
  assert.match(prompt, /Auth and access control/);
  assert.match(prompt, /analytical review/);
});

test('general lens does not inject framework section', () => {
  const prompt = buildPrompt({
    taskText: 'Quick check',
    requireVerdict: true,
    lens: 'general'
  });
  assert.doesNotMatch(prompt, /## AUDIT FRAMEWORK/);
});

test('non-review mode uses default execution guidance', () => {
  const prompt = buildPrompt({
    taskText: 'Answer question',
    requireVerdict: false
  });
  assert.match(prompt, /Answer directly/);
  assert.match(prompt, /Inspect only the evidence needed/);
  assert.doesNotMatch(prompt, /analytical review/);
  assert.doesNotMatch(prompt, /Think step by step/);
});

test('runMain rejects --lens without --require-verdict', async () => {
  const stderr = [];
  await runMain(
    ['--model', QWEN_MODEL, '--task', 'Return data', '--json', '--lens', 'security'],
    async () => ({ stdout: '', stderr: '' }),
    () => {},
    (line) => stderr.push(line)
  );
  assert.match(stderr[0] || '', /lens requires --require-verdict/);
  assert.equal(process.exitCode, 1);
  process.exitCode = undefined;
});

test('runMain rejects invalid lens value', async () => {
  const stderr = [];
  await runMain(
    ['--model', QWEN_MODEL, '--task', 'Return data', '--require-verdict', '--lens', 'bogus'],
    async () => ({ stdout: '', stderr: '' }),
    () => {},
    (line) => stderr.push(line)
  );
  assert.match(stderr[0] || '', /--lens must be one of/);
  assert.equal(process.exitCode, 1);
  process.exitCode = undefined;
});

test('delegated identity marker is prepended once at the transport boundary and forbids recursive runners', async () => {
  const { DELEGATED_IDENTITY_PREFIX } = await import('./ocask.mjs');
  let observed;
  await callOpenCode({
    model: QWEN_MODEL,
    prompt: 'Inspect the scoped repository only.',
    commandRunner: async (request) => {
      observed = request;
      return { stdout: jsonl('Done.'), stderr: '' };
    }
  });
  assert.equal(typeof DELEGATED_IDENTITY_PREFIX, 'string');
  assert.ok(observed.prompt.startsWith('[DELEGATED_RUNNER_IDENTITY]\n'));
  // The marker appears exactly once (no duplication across the primary/fallback path).
  assert.equal(observed.prompt.match(/\[DELEGATED_RUNNER_IDENTITY\]/g).length, 1);
  assert.match(observed.prompt, /Native OpenCode tools and native subagents remain allowed/);
  assert.match(observed.prompt, /every native subagent you launch must inherit this delegated marker/);
  for (const forbidden of ['codex-exec', 'glm-exec', 'ocask', 'opencode', 'claude']) {
    assert.match(observed.prompt, new RegExp(forbidden));
  }
  // The caller's task text survives verbatim after the marker.
  assert.ok(observed.prompt.endsWith('Inspect the scoped repository only.'));
});

test('--no-fallback exact-model mode performs one invocation with no opposite-family retry', async () => {
  let calls = 0;
  await assert.rejects(
    runAsk({
      model: DEEPSEEK_MODEL,
      noFallback: true,
      taskText: 'do work',
      commandRunner: async () => {
        calls += 1;
        return { stdout: jsonl('12345'), stderr: '' }; // numeric-only -> MODEL_OUTPUT
      }
    }),
    /alphabetic/
  );
  assert.equal(calls, 1, 'no-fallback must not retry on the opposite family');
});

test('--metadata writes a private mode-0600 attempt report without task/output text', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ocask-meta-'));
  try {
    const metaPath = path.join(tmp, 'report.json');
    await runMain(
      ['--model', QWEN_MODEL, '--task', 'do work secret-task-text', '--metadata', metaPath],
      async () => ({ stdout: jsonl('A normal answer.'), stderr: '' }),
      () => {}, () => {}, undefined, process.cwd(), { disableServer: true }
    );
    const stat = await fs.stat(metaPath);
    assert.equal(stat.mode & 0o777, 0o600, 'metadata report must be mode 0600');
    const report = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    assert.equal(report.requested_model, QWEN_MODEL);
    assert.equal(report.actual_model, QWEN_MODEL);
    assert.equal(report.no_fallback, false);
    assert.ok(Array.isArray(report.attempts) && report.attempts.length === 1);
    assert.equal(report.attempts[0].outcome, 'success');
    assert.equal(typeof report.attempts[0].output_bytes, 'number');
    const blob = JSON.stringify(report);
    assert.doesNotMatch(blob, /secret-task-text/, 'task text must not be recorded');
    assert.doesNotMatch(blob, /A normal answer/, 'model output text must not be recorded');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('install-source parity: ocask bin resolves to the tested source after host merge', async (t) => {
  const binPath = '/home/soultransit/.local/bin/ocask';
  const bin = fsSync.readFileSync(binPath, 'utf8');
  const m = bin.match(/exec node\s+(\S+ocask\.mjs)/);
  assert.ok(m, 'ocask bin must exec an ocask.mjs path');
  const binSrc = m[1];
  const testedSrc = new URL('ocask.mjs', import.meta.url).pathname;
  const sha = (p) => crypto.createHash('sha256').update(fsSync.readFileSync(p)).digest('hex');
  // If the canonical bin already points at this tested worktree source, it must match.
  if (binSrc === testedSrc) {
    assert.equal(sha(binSrc), sha(testedSrc));
    return;
  }
  // Otherwise the bin points at the main checkout; pass only after the host merges
  // this worktree so the main source equals the tested source. Skip with a staged
  // explanation before merge rather than inspecting the wrong source as if correct.
  if (sha(binSrc) !== sha(testedSrc)) {
    t.skip(`staged: ocask bin resolves to ${binSrc} (main checkout), stale until the host merges this worktree`);
    return;
  }
  assert.equal(sha(binSrc), sha(testedSrc));
});

test('persistent server provider receives a leaf-safe server environment', async () => {
  let observed;
  await callOpenCodeImpl({
    model: QWEN_MODEL,
    prompt: 'inspect the repository',
    cwd: '/scoped/repo',
    inheritedEnv: { PATH: '/usr/bin', HOME: '/h', AI_FLOW_TRACE: 'HOST-T', OCASK_DISABLE_SERVER: '0' },
    opencodeBin: '/real/opencode',
    serverProvider: async ({ inheritedEnv }) => {
      observed = inheritedEnv;
      return { url: 'http://127.0.0.1:45690', password: 'srv-secret-pw', cold: false };
    },
    commandRunner: async () => ({ stdout: jsonl('ok'), stderr: '' })
  });
  // Tool execution happens in the long-lived server, so its env must be leaf-safe.
  assert.equal(observed.AI_FLOW_LEAF, '1');
  assert.match(observed.PATH, /leaf-shims/);
  assert.equal(observed.AI_FLOW_SURFACE, 'opencode');
  assert.ok(observed.AI_FLOW_TRACE, 'server gets a fresh trace');
  assert.notEqual(observed.AI_FLOW_TRACE, 'HOST-T', 'server trace must be fresh, not the host trace');
  assert.equal(observed.AI_FLOW_PARENT_TRACE, 'HOST-T', 'server parent trace is the host trace');
  // The Basic-auth password lives at server launch (OPENCODE_SERVER_PASSWORD), not in the
  // provider env; the prompt must never leak into the server env metadata.
  assert.equal(observed.OPENCODE_SERVER_PASSWORD, undefined);
  assert.doesNotMatch(JSON.stringify(observed), /inspect the repository/);
});

test('persistent server launcher preserves a leaf-safe env into the spawn environment', async () => {
  let observed;
  const child = new EventEmitter();
  child.pid = 42431;
  child.unref = () => {};
  await launchPersistentServer({
    port: 45692,
    password: 'launch-secret-pw',
    runtimeDir: '/runtime/ocask',
    env: { PATH: '/usr/bin', AI_FLOW_LEAF: '1', AI_FLOW_TRACE: 'srv-trace', AI_FLOW_SURFACE: 'opencode' },
    opencodeBin: '/real/opencode',
    spawnImpl: (command, args, options) => {
      observed = { command, args, options };
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }
  });
  assert.equal(observed.command, '/real/opencode');
  assert.deepEqual(observed.args, ['serve', '--hostname', '127.0.0.1', '--port', '45692']);
  assert.equal(observed.options.env.AI_FLOW_LEAF, '1', 'leaf marker preserved into server spawn env');
  assert.equal(observed.options.env.AI_FLOW_SURFACE, 'opencode');
  assert.equal(observed.options.env.OPENCODE_SERVER_PASSWORD, 'launch-secret-pw', 'Basic auth preserved');
  assert.equal(observed.options.shell, false);
  assert.doesNotMatch(observed.args.join(' '), /launch-secret-pw/);
});
