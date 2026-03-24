import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  agentFolder: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  agentFolder: string;
  retryCount: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn:
    | ((agentFolder: string) => Promise<boolean>)
    | null = null;
  private shuttingDown = false;

  private getGroup(agentFolder: string): GroupState {
    let state = this.groups.get(agentFolder);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        agentFolder,
        retryCount: 0,
      };
      this.groups.set(agentFolder, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (agentFolder: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(agentFolder: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(agentFolder);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ agentFolder }, 'Container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(agentFolder)) {
        this.waitingGroups.push(agentFolder);
      }
      logger.debug(
        { agentFolder, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(agentFolder, 'messages').catch((err) =>
      logger.error({ agentFolder, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(
    agentFolder: string,
    taskId: string,
    fn: () => Promise<void>,
  ): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(agentFolder);

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      logger.debug({ agentFolder, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ agentFolder, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, agentFolder, fn });
      if (state.idleWaiting) {
        this.closeStdin(agentFolder);
      }
      logger.debug({ agentFolder, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, agentFolder, fn });
      if (!this.waitingGroups.includes(agentFolder)) {
        this.waitingGroups.push(agentFolder);
      }
      logger.debug(
        { agentFolder, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(agentFolder, { id: taskId, agentFolder, fn }).catch((err) =>
      logger.error({ agentFolder, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    agentFolder: string,
    proc: ChildProcess,
    containerName: string,
  ): void {
    const state = this.getGroup(agentFolder);
    state.process = proc;
    state.containerName = containerName;
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(agentFolder: string): void {
    const state = this.getGroup(agentFolder);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(agentFolder);
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(agentFolder: string, text: string): boolean {
    const state = this.getGroup(agentFolder);
    if (!state.active || state.isTaskContainer) return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    const inputDir = path.join(DATA_DIR, 'ipc', state.agentFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(agentFolder: string): void {
    const state = this.getGroup(agentFolder);
    if (!state.active) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.agentFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  private async runForGroup(
    agentFolder: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(agentFolder);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    this.activeCount++;

    logger.debug(
      { agentFolder, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(agentFolder);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(agentFolder, state);
        }
      }
    } catch (err) {
      logger.error(
        { agentFolder, err },
        'Error processing messages for group',
      );
      this.scheduleRetry(agentFolder, state);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      this.activeCount--;
      this.drainGroup(agentFolder);
    }
  }

  private async runTask(
    agentFolder: string,
    task: QueuedTask,
  ): Promise<void> {
    const state = this.getGroup(agentFolder);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;

    logger.debug(
      { agentFolder, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error(
        { agentFolder, taskId: task.id, err },
        'Error running task',
      );
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      this.activeCount--;
      this.drainGroup(agentFolder);
    }
  }

  private scheduleRetry(agentFolder: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { agentFolder, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { agentFolder, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(agentFolder);
      }
    }, delayMs);
  }

  private drainGroup(agentFolder: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(agentFolder);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(agentFolder, task).catch((err) =>
        logger.error(
          { agentFolder, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(agentFolder, 'drain').catch((err) =>
        logger.error(
          { agentFolder, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextFolder = this.waitingGroups.shift()!;
      const state = this.getGroup(nextFolder);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextFolder, task).catch((err) =>
          logger.error(
            { agentFolder: nextFolder, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextFolder, 'drain').catch((err) =>
          logger.error(
            { agentFolder: nextFolder, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      }
      // If neither pending, skip this group
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [_folder, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
