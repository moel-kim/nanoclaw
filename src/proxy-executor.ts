import { ChildProcess } from 'child_process';

import {
  ContainerInput,
  ContainerOutput,
  runContainerAgent,
} from './container-runner.js';
import { getAllAgents } from './db.js';
import { logger } from './logger.js';
import type {
  ProxyExecuteRequest,
  ProxyExecuteResponse,
} from './proxy-types.js';
import type { RegisteredGroup } from './types.js';

export interface ExecutorDeps {
  findGroup: (folder: string) => RegisteredGroup | undefined;
  runContainer: (
    group: RegisteredGroup,
    input: ContainerInput,
    onProcess: (proc: ChildProcess, name: string) => void,
  ) => Promise<ContainerOutput>;
}

function defaultDeps(): ExecutorDeps {
  return {
    findGroup(folder: string) {
      return getAllAgents().find((g) => g.folder === folder);
    },
    runContainer(group, input, onProcess) {
      return runContainerAgent(group, input, onProcess);
    },
  };
}

export async function executeSpecialist(
  request: ProxyExecuteRequest,
  timeoutMs: number,
  deps: ExecutorDeps = defaultDeps(),
): Promise<ProxyExecuteResponse> {
  const start = Date.now();
  const { group: groupFolder, prompt, correlationId } = request;

  const group = deps.findGroup(groupFolder);
  if (!group) {
    return {
      status: 'error',
      result: null,
      group: groupFolder,
      correlationId,
      executionMs: Date.now() - start,
      error: `Unknown group: ${groupFolder}`,
    };
  }

  const containerInput: ContainerInput = {
    prompt,
    groupFolder: group.folder,
    chatJid: `proxy:${correlationId}`,
    isMain: false,
    assistantName: group.assistantName,
  };

  try {
    const result = await Promise.race([
      deps.runContainer(group, containerInput, (_proc, _name) => {
        logger.debug(
          { correlationId, group: groupFolder },
          'Proxy container spawned',
        );
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error('proxy_timeout')),
          timeoutMs,
        ),
      ),
    ]);

    return {
      status: result.status === 'success' ? 'success' : 'error',
      result: result.result,
      group: groupFolder,
      correlationId,
      executionMs: Date.now() - start,
      sessionId: result.newSessionId,
      error: result.error,
    };
  } catch (err) {
    const isTimeout =
      err instanceof Error && err.message === 'proxy_timeout';

    if (isTimeout) {
      return {
        status: 'timeout',
        result: null,
        group: groupFolder,
        correlationId,
        executionMs: Date.now() - start,
        fallbackText: `Specialist "${groupFolder}" is still working. Check back shortly.`,
      };
    }

    return {
      status: 'error',
      result: null,
      group: groupFolder,
      correlationId,
      executionMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
