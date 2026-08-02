import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const runner = resolve(process.cwd(), 'scripts/qa/run-bounded.ps1');
const logRoot = 'C:\\tmp\\portkheaw-qa';
const lockPath = join(logRoot, '.portkheaw-qa.lock.json');

function run(command: string, options: {
  timeoutSeconds?: number;
  runId?: string;
  retryCount?: number;
  retryOnTimeout?: boolean;
} = {}) {
  const runId = options.runId ?? `smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

afterEach(() => {
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8').replace(/^\uFEFF/, '')) as { runId?: string };
    if (lock.runId === 'stale-smoke') rmSync(lockPath);
  }
});

describe.sequential('bounded PowerShell runner smoke tests', () => {
  it('returns zero for a successful command and stores logs outside the repo', () => {
    const { runId, result } = run("Write-Output 'runner-ok'; exit 0");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(output(result)).toContain('exit=0');
    expect(readFileSync(join(logRoot, runId, 'stdout.attempt-1.log'), 'utf8')).toContain('runner-ok');
  }, 20_000);

  it('returns the real non-zero exit code without retrying an unlisted error', () => {
    const { result } = run('exit 7');
    expect(result.status).toBe(7);
    expect(output(result)).toContain('no retry; exit 7');
  }, 20_000);

  it('times out, reports the step, and returns 124', () => {
    const { result } = run('Start-Sleep -Seconds 30', { timeoutSeconds: 2 });
    expect(result.status).toBe(124);
    expect(output(result)).toContain('TIMEOUT: runner-smoke');
    expect(output(result)).toContain('PID/tree closed:');
  }, 20_000);

  it('kills a child process when its owned tree times out', () => {
    const runId = `child-smoke-${Date.now()}`;
    const runDirectory = join(logRoot, runId);
    const childPidPath = join(runDirectory, 'child.pid');
    const escapedPidPath = childPidPath.replaceAll("'", "''");
    const command = `$child = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30') -WindowStyle Hidden -PassThru; Set-Content -LiteralPath '${escapedPidPath}' -Value $child.Id; Start-Sleep -Seconds 30`;
    const { result } = run(command, { timeoutSeconds: 8, runId });
    expect(result.status).toBe(124);
    const childPid = Number(readFileSync(childPidPath, 'utf8').trim());
    const aliveCheck = spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `if (Get-Process -Id ${childPid} -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }`,
    ], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
    expect(aliveCheck.status).toBe(0);
  }, 25_000);

  it('removes a lock only when its recorded owner is stale', () => {
    mkdirSync(logRoot, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      runId: 'stale-smoke',
      runnerPid: 2_147_483_646,
      runnerStartTimeUtc: '2000-01-01T00:00:00.000Z',
    }));
    const { result } = run('exit 0');
    expect(result.status).toBe(0);
    expect(output(result)).toContain('STALE_LOCK_REMOVED');
    expect(existsSync(lockPath)).toBe(false);
  }, 20_000);
});
