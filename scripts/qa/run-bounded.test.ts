import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
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

function run(command: string, options: {
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
  const result = spawnSync('powershell.exe', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: budgetMs(options.timeoutSeconds ?? 10),
    windowsHide: true,
  });
  /*
   * Said before any exit code is read, so a blown budget names itself instead of
   * arriving as "expected null to be 124" — the runner's exit code is `null`
   * precisely when it never got to choose one.
   */
  expect(result.error, `runner did not run to completion: ${output(result)}`).toBeUndefined();
  expect(result.signal, `runner was killed by the harness, not by itself: ${output(result)}`)
    .toBeNull();
  return { runId, logRoot, result };
}

function output(result: ReturnType<typeof spawnSync>) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
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
function waitForProcessExit(pid: number, withinMs = 5_000): void {
  const deadline = Date.now() + withinMs;
  while (processExists(pid) && Date.now() < deadline) {
    // Synchronous on purpose: the assertion that follows is synchronous too.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

afterAll(() => {
  rmSync(suiteRoot, { recursive: true, force: true });
});

describe.sequential('bounded PowerShell runner smoke tests', () => {
  it('returns zero for a successful command and stores logs outside the repo', () => {
    const { logRoot, runId, result } = run("Write-Output 'runner-ok'; exit 0");
    expect(result.error).toBeUndefined();
    expect(result.status, output(result)).toBe(0);
    expect(output(result)).toContain('exit=0');
    expect(readFileSync(join(logRoot, runId, 'stdout.attempt-1.log'), 'utf8')).toContain('runner-ok');
    expect(existsSync(join(logRoot, '.portkheaw-qa.lock.json'))).toBe(false);
  }, caseTimeoutMs(10));

  it('returns the real non-zero exit code without retrying an unlisted error', () => {
    const { result } = run('exit 7');
    expect(result.status, output(result)).toBe(7);
    expect(output(result)).toContain('no retry; exit 7');
  }, caseTimeoutMs(10));

  it('times out, reports the step, and returns 124', () => {
    const { result } = run('Start-Sleep -Seconds 30', { timeoutSeconds: 2 });
    expect(result.status, output(result)).toBe(124);
    expect(output(result)).toContain('TIMEOUT: runner-smoke');
    expect(output(result)).toContain('PID/tree closed:');
  }, caseTimeoutMs(2));

  it('kills a child process when its owned tree times out', () => {
    const runId = `child-smoke-${Date.now()}`;
    const logRoot = join(suiteRoot, runId);
    const runDirectory = join(logRoot, runId);
    const childPidPath = join(runDirectory, 'child.pid');
    const escapedPidPath = childPidPath.replaceAll("'", "''");
    const command = `$child = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30') -WindowStyle Hidden -PassThru; Set-Content -LiteralPath '${escapedPidPath}' -Value $child.Id; Start-Sleep -Seconds 30`;
    const { result } = run(command, { timeoutSeconds: 8, runId, logRoot });
    expect(result.status, output(result)).toBe(124);
    const childPid = Number(readFileSync(childPidPath, 'utf8').trim());
    waitForProcessExit(childPid);
    expect(processExists(childPid)).toBe(false);
  }, caseTimeoutMs(8));

  it('removes a lock only when its recorded owner is stale', () => {
    const logRoot = join(suiteRoot, `stale-${randomUUID()}`);
    const lockPath = join(logRoot, '.portkheaw-qa.lock.json');
    mkdirSync(logRoot, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      runId: 'stale-smoke',
      runnerPid: 2_147_483_646,
      runnerStartTimeUtc: '2000-01-01T00:00:00.000Z',
    }));
    const { result } = run('exit 0', { logRoot });
    expect(result.status, output(result)).toBe(0);
    expect(output(result)).toContain('STALE_LOCK_REMOVED');
    expect(existsSync(lockPath)).toBe(false);
  }, caseTimeoutMs(10));
});
