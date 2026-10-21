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
import { createAiDocumentRewordCancellation, registerAiApplicationDocumentRoutes } from '../ai-application-document-routes.js';
import { registerAiInterviewPreparationRoutes } from '../ai-interview-preparation-routes.js';
import { registerAiInterviewMockFeedbackRoutes } from '../ai-interview-mock-feedback-routes.js';

/** Account sign-in and individual data-sharing consent are separate from this installation capability. */
export async function registerAiRuntime(app: FastifyInstance, workspace: (request: FastifyRequest) => string, options: { enabled: boolean; codexEnabled?: boolean; identitySalt: string; storageRoot: string; ollamaBaseUrl: string }) {
  const codexEnabled = options.codexEnabled ?? options.enabled;
  const queue = createAiQueue(pool);
  const documentReword = createAiDocumentRewordCancellation();
  const worker = createAiWorker({ pool, queue, identitySalt: options.identitySalt, enabled: options.enabled, ollamaBaseUrl: options.ollamaBaseUrl,
    onEvent: event => app.log.warn({ event }, 'Assistant task unavailable'),
  });
  const cancelRun = (id: string) => { worker.cancelRun(id); documentReword.cancelRun(id); };
  const cancelConnection = (workspaceId: string, connectionId: string) => { worker.cancelConnection(workspaceId, connectionId); documentReword.cancelConnection(workspaceId, connectionId); };
  const repository = createAiConnectionRepository(db, queue, cancelConnection);
  registerAiConnectionRoutes(app, workspace, { ...options, enabled: codexEnabled, repository });
  const { registerOllamaConnectionRoutes } = await import('../ai/ollama-connection-routes.js');
  registerOllamaConnectionRoutes(app, workspace, { enabled: options.enabled, baseUrl: options.ollamaBaseUrl, queue, cancelConnection });
  registerAiRunRoutes(app, workspace, { enabled: options.enabled, database: db, queue, cancelRun });
  registerAiAnswerRoutes(app, workspace, db);
  registerAiDocumentRoutes(app, workspace, { database: db, storageRoot: options.storageRoot });
  registerAiApplicationDocumentRoutes(app,workspace,{enabled:codexEnabled,database:db,storageRoot:options.storageRoot,identitySalt:options.identitySalt,queue,cancellation:documentReword});
  registerAiInterviewPreparationRoutes(app, workspace, { enabled: codexEnabled, database: db, identitySalt: options.identitySalt, queue, cancellation: documentReword });
  registerAiInterviewMockFeedbackRoutes(app, workspace, { enabled: codexEnabled, database: db, identitySalt: options.identitySalt, queue, cancellation: documentReword });
  const automation = createAiAutomationService({ pool, queue, enabled: codexEnabled, cancelRun });
  registerAiAutomationRoutes(app, workspace, automation);
  const scanner = createAiAutomationScanner(automation, { enabled: codexEnabled });
  const history = createAiHistoryService({ pool });
  registerAiHistoryRoutes(app, workspace, history);
  const maintenance = createAiHistoryMaintenance(history, { onError: () => app.log.warn('Assistant history maintenance unavailable') });
  // Expired leases become interrupted; uncertain work is never resubmitted after restarting.
  await queue.recoverAfterRestart();
  app.addHook('onClose', async () => { await maintenance.stop(); await scanner.stop(); await worker.stop(); await documentReword.close(); });
  maintenance.start();
  if (options.enabled) worker.start();
  if (codexEnabled) scanner.start();
  return {
    queue, worker,
    /** Stops every assistant task and background job of this process, waiting for the current one to end. */
    async pause() { await maintenance.stop(); await scanner.stop(); await worker.stop(); },
    resume() { maintenance.start(); if (options.enabled) worker.start(); if (codexEnabled) scanner.start(); },
  };
}
