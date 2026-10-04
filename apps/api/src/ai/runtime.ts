import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db, pool } from '@career/db';
import { registerAiConnectionRoutes } from '../ai-connection-routes.js';
import { registerAiRunRoutes } from '../ai-run-routes.js';
import { registerAiAnswerRoutes } from '../ai-answer-routes.js';
import { createAiConnectionRepository } from './connection-store.js';
import { createAiQueue } from './queue.js';
import { createAiWorker } from './worker.js';
import { registerAiDocumentRoutes } from '../ai-document-routes.js';
import { registerAiAutomationRoutes } from '../ai-automation-routes.js';
import { createAiAutomationService, createAiAutomationScanner } from './automation.js';
import { registerAiHistoryRoutes } from '../ai-history-routes.js';
import { createAiHistoryService, createAiHistoryMaintenance } from './history.js';

/** Account sign-in and individual data-sharing consent are separate from this installation capability. */
export async function registerAiRuntime(app: FastifyInstance, workspace: (request: FastifyRequest) => string, options: { enabled: boolean; identitySalt: string; storageRoot: string }) {
  const queue = createAiQueue(pool);
  const worker = createAiWorker({ pool, queue, identitySalt: options.identitySalt, enabled: options.enabled,
    onEvent: event => app.log.warn({ event }, 'Assistant task unavailable'),
  });
  const repository = createAiConnectionRepository(db, queue, worker.cancelConnection);
  registerAiConnectionRoutes(app, workspace, { ...options, repository });
  registerAiRunRoutes(app, workspace, { enabled: options.enabled, database: db, queue, cancelRun: worker.cancelRun });
  registerAiAnswerRoutes(app, workspace, db);
  registerAiDocumentRoutes(app, workspace, { database: db, storageRoot: options.storageRoot });
  const automation = createAiAutomationService({ pool, queue, enabled: options.enabled, cancelRun: worker.cancelRun });
  registerAiAutomationRoutes(app, workspace, automation);
  const scanner = createAiAutomationScanner(automation, { enabled: options.enabled });
  const history = createAiHistoryService({ pool });
  registerAiHistoryRoutes(app, workspace, history);
  const maintenance = createAiHistoryMaintenance(history, { onError: () => app.log.warn('Assistant history maintenance unavailable') });
  // Expired leases become interrupted; uncertain work is never resubmitted after restarting.
  await queue.recoverAfterRestart();
  app.addHook('onClose', async () => { await maintenance.stop(); await scanner.stop(); await worker.stop(); });
  maintenance.start();
  if (options.enabled) { worker.start(); scanner.start(); }
  return { queue, worker };
}
