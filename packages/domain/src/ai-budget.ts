import type { AiOperation, AiRunOrigin } from './ai.js';

export const AI_LIMITS = Object.freeze({
  queuedPerWorkspace: 20, manualQueued: 3, automaticReservationsPerPass: 5, automaticStartsPerUtcDay: 10,
  concurrentPerWorkspace: 1, concurrentPerAccount: 1, inputCharacters: 80_000,
  outputBytes: 256 * 1024, timeoutMs: 120_000, killGraceMs: 5_000,
});

export function aiControlDay(nowMs: number): { day: string; resetsAt: string } {
  if (!Number.isFinite(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) throw new RangeError('Invalid control time');
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return { day, resetsAt: new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString() };
}

/** Counts must be read under the same database lock as reservation/claim. These pure checks do not reserve anything. */
export type AiQueueBudget = {
  queuedManual: number;
  queuedAutomatic: number;
  /** Includes starts with failed, cancelled or uncertain outcomes. Cancelling a queued reservation is not a start. */
  automaticStarts: number;
  startsDay: string;
};
export type AiAdmissionReason = 'INVALID_STATE' | 'EQUIVALENT_ACTIVE' | 'QUEUE_FULL' | 'MANUAL_QUEUE_FULL'
  | 'AUTOMATION_NOT_SUPPORTED' | 'PASS_LIMIT' | 'DAILY_LIMIT' | 'WORKSPACE_BUSY' | 'ACCOUNT_BUSY' | 'MANUAL_FIRST';
export type AiAdmission = { allowed: true; controlDay: string } | { allowed: false; reason: AiAdmissionReason; resetsAt?: string };
const natural = (value: number) => Number.isSafeInteger(value) && value >= 0;

function budgetAt(budget: AiQueueBudget, nowMs: number) {
  const window = aiControlDay(nowMs);
  const parsed = Date.parse(`${budget.startsDay}T00:00:00.000Z`);
  const validDay = /^\d{4}-\d{2}-\d{2}$/.test(budget.startsDay) && Number.isFinite(parsed)
    && new Date(parsed).toISOString().slice(0, 10) === budget.startsDay && budget.startsDay <= window.day;
  if (!validDay || ![budget.queuedManual, budget.queuedAutomatic, budget.automaticStarts].every(natural)) return null;
  return { ...window, starts: budget.startsDay === window.day ? budget.automaticStarts : 0 };
}

/** Recheck permissions and provider capability independently before calling this function. No quota is inferred here. */
export function checkAiReservation(input: {
  budget: AiQueueBudget; origin: AiRunOrigin; operation: AiOperation; equivalentActive: boolean;
  automaticReservationsThisPass: number; nowMs: number;
}): AiAdmission {
  const current = budgetAt(input.budget, input.nowMs);
  if (!current || !natural(input.automaticReservationsThisPass)) return { allowed: false, reason: 'INVALID_STATE' };
  if (input.equivalentActive) return { allowed: false, reason: 'EQUIVALENT_ACTIVE' };
  if (input.budget.queuedManual + input.budget.queuedAutomatic >= AI_LIMITS.queuedPerWorkspace) return { allowed: false, reason: 'QUEUE_FULL' };
  if (input.origin === 'MANUAL') {
    if (input.budget.queuedManual >= AI_LIMITS.manualQueued) return { allowed: false, reason: 'MANUAL_QUEUE_FULL' };
  } else {
    if (input.operation !== 'JOB_ANALYSIS') return { allowed: false, reason: 'AUTOMATION_NOT_SUPPORTED' };
    if (input.automaticReservationsThisPass >= AI_LIMITS.automaticReservationsPerPass) return { allowed: false, reason: 'PASS_LIMIT' };
    // Pending reservations consume capacity until they start, expire or are cancelled; they survive midnight.
    if (current.starts + input.budget.queuedAutomatic >= AI_LIMITS.automaticStartsPerUtcDay) {
      return { allowed: false, reason: 'DAILY_LIMIT', resetsAt: current.resetsAt };
    }
  }
  return { allowed: true, controlDay: current.day };
}

/**
 * Rechecked immediately before dispatch. The transaction must atomically claim the run and charge today's start.
 * The account lock spans workspaces using that auth context. Never interrupt a running task to prioritize another.
 */
export function checkAiStart(input: {
  budget: AiQueueBudget; origin: AiRunOrigin; operation: AiOperation; workspaceRunning: number; accountRunning: number; nowMs: number;
}): AiAdmission {
  const current = budgetAt(input.budget, input.nowMs);
  if (!current || !natural(input.workspaceRunning) || !natural(input.accountRunning)) return { allowed: false, reason: 'INVALID_STATE' };
  if (input.workspaceRunning >= AI_LIMITS.concurrentPerWorkspace) return { allowed: false, reason: 'WORKSPACE_BUSY' };
  if (input.accountRunning >= AI_LIMITS.concurrentPerAccount) return { allowed: false, reason: 'ACCOUNT_BUSY' };
  if (input.origin === 'AUTOMATIC') {
    if (input.operation !== 'JOB_ANALYSIS') return { allowed: false, reason: 'AUTOMATION_NOT_SUPPORTED' };
    if (input.budget.queuedManual > 0) return { allowed: false, reason: 'MANUAL_FIRST' };
    if (current.starts >= AI_LIMITS.automaticStartsPerUtcDay) return { allowed: false, reason: 'DAILY_LIMIT', resetsAt: current.resetsAt };
  }
  return { allowed: true, controlDay: current.day };
}
