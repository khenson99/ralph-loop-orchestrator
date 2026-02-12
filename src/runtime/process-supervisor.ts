import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Logger } from 'pino';

export type RuntimeProcessId = 'planner' | 'team' | 'reviewer';
export type RuntimeProcessStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'completed' | 'failed';
export type RuntimeProcessAction = 'start' | 'stop' | 'restart';

export type RuntimeProcessSnapshot = {
  process_id: RuntimeProcessId;
  display_name: string;
  status: RuntimeProcessStatus;
  pid: number | null;
  run_count: number;
  last_started_at: string | null;
  last_stopped_at: string | null;
  last_exit_code: number | null;
  last_signal: string | null;
  command: string;
  args: string[];
  error: string | null;
};

export type RuntimeLogEntry = {
  seq: number;
  process_id: RuntimeProcessId;
  run_id: number;
  timestamp: string;
  stream: 'stdout' | 'stderr' | 'system';
  line: string;
};

export type RuntimeSupervisorEvent =
  | {
      type: 'status';
      process: RuntimeProcessSnapshot;
      action: RuntimeProcessAction | 'system';
    }
  | {
      type: 'log';
      process_id: RuntimeProcessId;
      entry: RuntimeLogEntry;
    };

type SupervisorOptions = {
  cwd: string;
  plannerPrdPath?: string;
  plannerMaxIterations: number;
  teamMaxIterations: number;
  reviewerMaxIterations: number;
  maxLogLines: number;
  logger: Logger;
};

type ActionInput = {
  processId: RuntimeProcessId;
  action: RuntimeProcessAction;
  requestedBy: string;
  reason: string;
  maxIterations?: number;
  prdPath?: string;
};

export type RuntimeActionResult = {
  accepted: boolean;
  process: RuntimeProcessSnapshot;
  error?: string;
};

type ManagedProcess = {
  id: RuntimeProcessId;
  displayName: string;
  scriptPath: string;
  status: RuntimeProcessStatus;
  child: ChildProcessWithoutNullStreams | null;
  pid: number | null;
  runCount: number;
  runId: number;
  lastStartedAt: string | null;
  lastStoppedAt: string | null;
  lastExitCode: number | null;
  lastSignal: string | null;
  command: string;
  args: string[];
  error: string | null;
  logs: RuntimeLogEntry[];
  logSeq: number;
  stdoutBuffer: string;
  stderrBuffer: string;
};

function normalizeIterations(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.floor(value), 500));
}

export class ProcessSupervisor {
  private readonly cwd: string;
  private readonly plannerPrdPath?: string;
  private readonly plannerMaxIterations: number;
  private readonly teamMaxIterations: number;
  private readonly reviewerMaxIterations: number;
  private readonly maxLogLines: number;
  private readonly logger: Logger;
  private readonly listeners = new Set<(event: RuntimeSupervisorEvent) => void>();
  private readonly processMap: Record<RuntimeProcessId, ManagedProcess>;

  constructor(options: SupervisorOptions) {
    this.cwd = options.cwd;
    this.plannerPrdPath = options.plannerPrdPath;
    this.plannerMaxIterations = normalizeIterations(options.plannerMaxIterations, 10);
    this.teamMaxIterations = normalizeIterations(options.teamMaxIterations, 20);
    this.reviewerMaxIterations = normalizeIterations(options.reviewerMaxIterations, 10);
    this.maxLogLines = Math.max(200, Math.min(options.maxLogLines, 20000));
    this.logger = options.logger;

    this.processMap = {
      planner: this.createManagedProcess('planner', 'Planner', 'scripts/run-planner.sh'),
      team: this.createManagedProcess('team', 'Team', 'scripts/run-team.sh'),
      reviewer: this.createManagedProcess('reviewer', 'Reviewer', 'scripts/run-reviewer.sh'),
    };
  }

  subscribe(listener: (event: RuntimeSupervisorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listProcesses(): RuntimeProcessSnapshot[] {
    return (Object.keys(this.processMap) as RuntimeProcessId[]).map((id) => this.snapshot(id));
  }

  listLogs(processId: RuntimeProcessId, limit = 400): RuntimeLogEntry[] {
    const process = this.processMap[processId];
    const cappedLimit = Math.max(1, Math.min(Math.floor(limit), this.maxLogLines));
    return process.logs.slice(-cappedLimit);
  }

  async executeAction(input: ActionInput): Promise<RuntimeActionResult> {
    switch (input.action) {
      case 'start':
        return this.start(input.processId, input);
      case 'stop':
        return this.stop(input.processId, input);
      case 'restart': {
        const stopped = await this.stop(input.processId, input, true);
        if (!stopped.accepted) {
          return stopped;
        }
        return this.start(input.processId, input);
      }
      default: {
        const unreachable: never = input.action;
        throw new Error(`Unsupported process action: ${unreachable}`);
      }
    }
  }

  async shutdown(): Promise<void> {
    const processIds = Object.keys(this.processMap) as RuntimeProcessId[];
    await Promise.all(processIds.map((id) => this.stop(id, this.systemAction(id, 'shutdown'), true)));
  }

  private createManagedProcess(id: RuntimeProcessId, displayName: string, scriptPath: string): ManagedProcess {
    return {
      id,
      displayName,
      scriptPath: resolve(this.cwd, scriptPath),
      status: 'idle',
      child: null,
      pid: null,
      runCount: 0,
      runId: 0,
      lastStartedAt: null,
      lastStoppedAt: null,
      lastExitCode: null,
      lastSignal: null,
      command: 'bash',
      args: [],
      error: null,
      logs: [],
      logSeq: 0,
      stdoutBuffer: '',
      stderrBuffer: '',
    };
  }

  private systemAction(processId: RuntimeProcessId, reason: string): ActionInput {
    return {
      processId,
      action: 'stop',
      requestedBy: 'system',
      reason,
    };
  }

  private async start(processId: RuntimeProcessId, input: ActionInput): Promise<RuntimeActionResult> {
    const process = this.processMap[processId];
    if (process.status === 'starting' || process.status === 'running' || process.status === 'stopping') {
      return { accepted: false, process: this.snapshot(processId), error: 'process_not_idle' };
    }

    if (!existsSync(process.scriptPath)) {
      process.error = `Script not found: ${process.scriptPath}`;
      this.emitStatus(process, 'start');
      return { accepted: false, process: this.snapshot(processId), error: 'script_not_found' };
    }

    const argsResult = this.buildArgs(processId, input);
    if (!argsResult.ok) {
      process.error = argsResult.error;
      this.emitStatus(process, 'start');
      return { accepted: false, process: this.snapshot(processId), error: argsResult.error_code };
    }

    process.error = null;
    process.status = 'starting';
    process.command = 'bash';
    process.args = [process.scriptPath, ...argsResult.args];
    process.runCount += 1;
    process.runId = process.runCount;
    process.stdoutBuffer = '';
    process.stderrBuffer = '';
    process.lastStartedAt = new Date().toISOString();
    this.pushSystemLog(
      process,
      `start requested by ${input.requestedBy} (${input.reason || 'no reason provided'})`,
    );
    this.emitStatus(process, 'start');

    try {
      const child = spawn('bash', [process.scriptPath, ...argsResult.args], {
        cwd: this.cwd,
        env: globalThis.process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      process.child = child;

      child.on('spawn', () => {
        process.pid = child.pid ?? null;
        process.status = 'running';
        process.error = null;
        this.pushSystemLog(process, `process started (pid ${process.pid ?? 'unknown'})`);
        this.emitStatus(process, 'start');
      });

      child.stdout.on('data', (chunk: Buffer) => {
        this.handleChunk(process, 'stdout', chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        this.handleChunk(process, 'stderr', chunk);
      });

      child.on('error', (error) => {
        process.error = error.message;
        process.status = 'failed';
        process.lastStoppedAt = new Date().toISOString();
        process.pid = null;
        process.child = null;
        this.pushSystemLog(process, `process error: ${error.message}`);
        this.emitStatus(process, 'system');
      });

      child.on('close', (code, signal) => {
        this.flushBuffers(process);
        process.lastExitCode = code;
        process.lastSignal = signal;
        process.lastStoppedAt = new Date().toISOString();
        const stoppedByUser = process.status === 'stopping';
        process.status = stoppedByUser ? 'idle' : code === 0 ? 'completed' : 'failed';
        process.child = null;
        process.pid = null;
        if (!stoppedByUser && code !== 0) {
          process.error = `process exited with code ${String(code ?? 'null')}`;
        }
        this.pushSystemLog(
          process,
          `process exited (code=${String(code ?? 'null')} signal=${String(signal ?? 'none')})`,
        );
        this.emitStatus(process, 'system');
      });
    } catch (error) {
      process.status = 'failed';
      process.error = error instanceof Error ? error.message : 'spawn_failed';
      this.pushSystemLog(process, `spawn failed: ${process.error}`);
      this.emitStatus(process, 'system');
      return { accepted: false, process: this.snapshot(processId), error: 'spawn_failed' };
    }

    return { accepted: true, process: this.snapshot(processId) };
  }

  private async stop(
    processId: RuntimeProcessId,
    input: ActionInput,
    allowIdle = false,
  ): Promise<RuntimeActionResult> {
    const process = this.processMap[processId];
    if (!process.child || process.pid === null) {
      if (allowIdle) {
        return { accepted: true, process: this.snapshot(processId) };
      }
      return { accepted: false, process: this.snapshot(processId), error: 'process_not_running' };
    }

    process.status = 'stopping';
    process.error = null;
    this.pushSystemLog(
      process,
      `stop requested by ${input.requestedBy} (${input.reason || 'no reason provided'})`,
    );
    this.emitStatus(process, 'stop');

    const child = process.child;
    child.kill('SIGTERM');

    const timeout = setTimeout(() => {
      if (process.child && process.status === 'stopping') {
        this.pushSystemLog(process, 'graceful stop timed out, forcing SIGKILL');
        process.child.kill('SIGKILL');
      }
    }, 5000);

    await new Promise<void>((resolveStop) => {
      child.once('close', () => {
        clearTimeout(timeout);
        resolveStop();
      });
    });

    return { accepted: true, process: this.snapshot(processId) };
  }

  private buildArgs(
    processId: RuntimeProcessId,
    input: ActionInput,
  ): { ok: true; args: string[] } | { ok: false; error: string; error_code: string } {
    const maxIterations = normalizeIterations(
      input.maxIterations,
      processId === 'planner'
        ? this.plannerMaxIterations
        : processId === 'team'
          ? this.teamMaxIterations
          : this.reviewerMaxIterations,
    );

    if (processId === 'planner') {
      const prdPath = input.prdPath?.trim() || this.plannerPrdPath;
      if (!prdPath) {
        return {
          ok: false,
          error: 'Planner requires a PRD path (set RALPH_PLANNER_PRD_PATH or send prd_path).',
          error_code: 'missing_prd_path',
        };
      }
      const fullPrdPath = resolve(this.cwd, prdPath);
      if (!existsSync(fullPrdPath)) {
        return {
          ok: false,
          error: `PRD file not found: ${fullPrdPath}`,
          error_code: 'prd_not_found',
        };
      }
      return {
        ok: true,
        args: ['--prd', fullPrdPath, '--max-iterations', String(maxIterations)],
      };
    }

    return {
      ok: true,
      args: ['--max-iterations', String(maxIterations)],
    };
  }

  private handleChunk(process: ManagedProcess, stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const chunkText = chunk.toString('utf8');
    const bufferKey = stream === 'stdout' ? 'stdoutBuffer' : 'stderrBuffer';
    process[bufferKey] += chunkText;
    const lines = process[bufferKey].split(/\r?\n/);
    process[bufferKey] = lines.pop() ?? '';
    for (const line of lines) {
      if (line.length === 0) {
        continue;
      }
      this.pushLog(process, stream, line);
    }
  }

  private flushBuffers(process: ManagedProcess): void {
    if (process.stdoutBuffer.length > 0) {
      this.pushLog(process, 'stdout', process.stdoutBuffer);
      process.stdoutBuffer = '';
    }
    if (process.stderrBuffer.length > 0) {
      this.pushLog(process, 'stderr', process.stderrBuffer);
      process.stderrBuffer = '';
    }
  }

  private pushSystemLog(process: ManagedProcess, line: string): void {
    this.pushLog(process, 'system', line);
  }

  private pushLog(process: ManagedProcess, stream: RuntimeLogEntry['stream'], line: string): void {
    process.logSeq += 1;
    const entry: RuntimeLogEntry = {
      seq: process.logSeq,
      process_id: process.id,
      run_id: process.runId,
      timestamp: new Date().toISOString(),
      stream,
      line,
    };
    process.logs.push(entry);
    if (process.logs.length > this.maxLogLines) {
      process.logs.splice(0, process.logs.length - this.maxLogLines);
    }

    this.logger.debug(
      { process_id: process.id, run_id: process.runId, stream, line },
      'runtime process log',
    );

    for (const listener of this.listeners) {
      listener({
        type: 'log',
        process_id: process.id,
        entry,
      });
    }
  }

  private emitStatus(process: ManagedProcess, action: RuntimeProcessAction | 'system'): void {
    const snapshot = this.snapshot(process.id);
    this.logger.info(
      {
        process_id: snapshot.process_id,
        status: snapshot.status,
        pid: snapshot.pid,
        run_count: snapshot.run_count,
        action,
        error: snapshot.error,
      },
      'runtime process status changed',
    );

    for (const listener of this.listeners) {
      listener({
        type: 'status',
        process: snapshot,
        action,
      });
    }
  }

  private snapshot(processId: RuntimeProcessId): RuntimeProcessSnapshot {
    const process = this.processMap[processId];
    return {
      process_id: process.id,
      display_name: process.displayName,
      status: process.status,
      pid: process.pid,
      run_count: process.runCount,
      last_started_at: process.lastStartedAt,
      last_stopped_at: process.lastStoppedAt,
      last_exit_code: process.lastExitCode,
      last_signal: process.lastSignal,
      command: process.command,
      args: process.args,
      error: process.error,
    };
  }
}
