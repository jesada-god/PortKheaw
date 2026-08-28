import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';

/*
 * HOW LONG THE RUNNER IS GIVEN ON TOP OF ITS OWN DEADLINE.
 *
 * These tests used a flat `timeout: 20_000` on `spawnSync`, and that number had
 * to cover three things: `powershell.exe` cold start, the runner's own
 * `-TimeoutSeconds` wait, and `taskkill /T /F` plus `WaitForExit` afterwards.
 * Only the middle one is under test. The first is a .NET process launch whose
 * cost is set by whatever else is on the machine, and under a full `vitest run`
 * — 562 files across every core — it measured past 20 seconds on its own.
 *
 * When that cap fired, `spawnSync` SIGTERM'd the runner mid-cleanup and returned
 * `{ status: null, signal: 'SIGTERM', error: ETIMEDOUT }`, so the suite reported
 * "expected null to be 124" — a contention failure wearing the costume of a
 * broken runner. Both cases that failed in a full run failed exactly there,
 * including the one that only asks `exit 0` to come back 0.
 *
 * So the budget is DERIVED from the deadline each case sets rather than fixed,
 * and the margin is sized for a cold start under load rather than for an idle
 * machine. Nothing about what is asserted changes: every case still demands the
 * runner's real exit code. What changes is that the only way to trip this cap is
 * a runner that genuinely never returns, which is the hang it was there to catch.
 */
const STARTUP_BUDGET_MS = 90_000;

/** The wall the runner must not hit — its own deadline, plus room to start. */
const budgetMs = (runnerTimeoutSeconds: number) =>
  runnerTimeoutSeconds * 1_000 + STARTUP_BUDGET_MS;

/** Vitest's ceiling, kept above the budget so `spawnSync` reports first. */
const caseTimeoutMs = (runnerTimeoutSeconds: number) => budgetMs(runnerTimeoutSeconds) + 15_000;

const runner = resolve(process.cwd(), 'scripts/qa/run-bounded.ps1');
const suiteRoot = join('C:\\tmp\\portkheaw-qa-tests', `vitest-${process.pid}-${randomUUID()}`);

async function run(command: string, options: {
  timeoutSeconds?: number;
  runId?: string;
  logRoot?: string;
  retryCount?: number;
  retryOnTimeout?: boolean;
} = {}) {
  const runId = options.runId ?? `smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const logRoot = options.logRoot ?? join(suiteRoot, runId);
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', runner,
    '-Command', command,
    '-TimeoutSeconds', String(options.timeoutSeconds ?? 10),
    '-LogDirectory', logRoot,
    '-RetryCount', String(options.retryCount ?? 0),
    '-Step', 'runner-smoke',
    '-RunId', runId,
  ];
  if (options.retryOnTimeout) args.push('-RetryOnTimeout');
  const result = await spawnRunner(args, budgetMs(options.timeoutSeconds ?? 10));
  /*
   * Said before any exit code is read, so a blown budget names itself instead of
   * arriving as "expected null to be 124" — the runner's exit code is `null`
   * precisely when it never got to choose one.
   */
  expect(result.timedOut, `runner did not run to completion: ${output(result)}`).toBe(false);
  expect(result.signal, `runner was killed by the harness, not by itself: ${output(result)}`)
    .toBeNull();
  return { runId, logRoot, result };
}

interface RunnerResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/*
 * ASYNC ON PURPOSE, and this is not a style preference.
 *
 * `spawnSync` blocks the worker THREAD for as long as the runner takes, and the
 * runner is deliberately slow — these cases exist to watch a deadline expire.
 * Vitest reports progress from inside the worker over an RPC channel with its
 * own timeout, so a worker parked in `spawnSync` for twenty-five seconds cannot
 * answer it: the run ended with every assertion passed, one unhandled
 * `[vitest-worker]: Timeout calling "onTaskUpdate"`, and a non-zero exit code.
 * Green tests, red run.
 *
 * Spawning asynchronously leaves the event loop free to service that channel
 * while the runner takes exactly as long as it always did.
 */
function spawnRunner(args: string[], budget: number): Promise<RunnerResult> {
  return new Promise((resolveResult) => {
    const child = spawn('powershell.exe', args, { cwd: process.cwd(), windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, budget);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolveResult({ status, signal, stdout, stderr, timedOut });
    });
  });
}

function output(result: RunnerResult) {
  return `${result.stdout}\n${result.stderr}`;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/**
 * Waits, briefly and boundedly, for a PID to stop resolving.
 *
 * `taskkill /T /F` returns once it has issued the kill, and the runner only
 * waits on the ROOT it spawned — the grandchild in the tree test is a separate
 * process that Windows may still be tearing down when the runner exits. Sampling
 * once at that instant is a race the test would lose occasionally and for a
 * reason that has nothing to do with the runner.
 *
 * This does not weaken the check: the caller still asserts the process is gone,
 * and a PID that is still alive at the end of this window fails exactly as it
 * did before. It only stops the assertion being read a few milliseconds early.
 */
async function waitForProcessExit(pid: number, withinMs = 5_000): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (processExists(pid) && Date.now() < deadline) {
    // Yields rather than blocks, for the reason `spawnRunner` is async.
    await new Promise((sleep) => { setTimeout(sleep, 50); });
  }
}

afterAll(() => {
  rmSync(suiteRoot, { recursive: true, force: true });
});

describe.sequential('bounded PowerShell runner smoke tests', () => {
  it('returns zero for a successful command and stores logs outside the repo', async () => {
    const { logRoot, runId, result } = await run("Write-Output 'runner-ok'; exit 0");
    // Same claim as before, on the shape `spawnRunner` returns: it finished on its own.
    expect(result.timedOut).toBe(false);
    expect(result.status, output(result)).toBe(0);
    expect(output(result)).toContain('exit=0');
    expect(readFileSync(join(logRoot, runId, 'stdout.attempt-1.log'), 'utf8')).toContain('runner-ok');
    expect(existsSync(join(logRoot, '.portkheaw-qa.lock.json'))).toBe(false);
  }, caseTimeoutMs(10));

  it('returns the real non-zero exit code without retrying an unlisted error', async () => {
    const { result } = await run('exit 7');
    expect(result.status, output(result)).toBe(7);
    expect(output(result)).toContain('no retry; exit 7');
  }, caseTimeoutMs(10));

  it('times out, reports the step, and returns 124', async () => {
    const { result } = await run('Start-Sleep -Seconds 30', { timeoutSeconds: 2 });
    expect(result.status, output(result)).toBe(124);
    expect(output(result)).toContain('TIMEOUT: runner-smoke');
    expect(output(result)).toContain('PID/tree closed:');
  }, caseTimeoutMs(2));

  it('kills a child process when its owned tree times out', async () => {
    const runId = `child-smoke-${Date.now()}`;
    const logRoot = join(suiteRoot, runId);
    const runDirectory = join(logRoot, runId);
    const childPidPath = join(runDirectory, 'child.pid');
    const escapedPidPath = childPidPath.replaceAll("'", "''");
    const command = `$child = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 120') -WindowStyle Hidden -PassThru; Set-Content -LiteralPath '${escapedPidPath}' -Value $child.Id; Start-Sleep -Seconds 120`;
    /*
     * 25s rather than 8s, and the sleeps are 120s rather than 30s.
     *
     * This command's FIRST act is to cold-start a second `powershell.exe`, and
     * only then does it write the PID the assertions read. At an 8s deadline
     * under a loaded machine the runner correctly timed out and killed the tree
     * before that write ever happened, and the test failed on a missing
     * `child.pid` — a fixture that never got built, reported as a runner that
     * had misbehaved. The deadline still fires far short of the sleeps, so the
     * timeout under test is every bit as real as it was.
     */
    const { result } = await run(command, { timeoutSeconds: 25, runId, logRoot });
    expect(result.status, output(result)).toBe(124);
    expect(
      existsSync(childPidPath),
      `the command never recorded its child PID, so the runner's deadline cut it short of writing one: ${output(result)}`,
    ).toBe(true);
    const childPid = Number(readFileSync(childPidPath, 'utf8').trim());
    await waitForProcessExit(childPid);
    expect(processExists(childPid)).toBe(false);
  }, caseTimeoutMs(25));

  it('removes a lock only when its recorded owner is stale', async () => {
    const logRoot = join(suiteRoot, `stale-${randomUUID()}`);
    const lockPath = join(logRoot, '.portkheaw-qa.lock.json');
    mkdirSync(logRoot, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      runId: 'stale-smoke',
      runnerPid: 2_147_483_646,
      runnerStartTimeUtc: '2000-01-01T00:00:00.000Z',
    }));
    const { result } = await run('exit 0', { logRoot });
    expect(result.status, output(result)).toBe(0);
    expect(output(result)).toContain('STALE_LOCK_REMOVED');
    expect(existsSync(lockPath)).toBe(false);
  }, caseTimeoutMs(10));
});
