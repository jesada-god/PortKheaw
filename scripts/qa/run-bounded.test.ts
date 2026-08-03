import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';

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
  return {
    runId,
    logRoot,
    result: spawnSync('powershell.exe', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
    }),
  };
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
  }, 20_000);

  it('returns the real non-zero exit code without retrying an unlisted error', () => {
    const { result } = run('exit 7');
    expect(result.status, output(result)).toBe(7);
    expect(output(result)).toContain('no retry; exit 7');
  }, 20_000);

  it('times out, reports the step, and returns 124', () => {
    const { result } = run('Start-Sleep -Seconds 30', { timeoutSeconds: 2 });
    expect(result.status, output(result)).toBe(124);
    expect(output(result)).toContain('TIMEOUT: runner-smoke');
    expect(output(result)).toContain('PID/tree closed:');
  }, 20_000);

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
    expect(processExists(childPid)).toBe(false);
  }, 25_000);

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
  }, 20_000);
});
