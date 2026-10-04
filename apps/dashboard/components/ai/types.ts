import type { AiUsageSnapshot } from '@career/domain';

export type AiSessionState = 'NOT_INSTALLED' | 'SIGNED_OUT' | 'SIGNED_IN' | 'UNSUPPORTED' | 'UNAVAILABLE';

/** Public account metadata only. Credentials stay with the official Codex installation. */
export type AiSessionObservation = {
  id: string;
  sessionState: AiSessionState;
  version: string | null;
  maskedIdentity: string | null;
  plan: string | null;
  usage: AiUsageSnapshot | null;
};

export type AiConnection = AiSessionObservation & { authorized: boolean };
export type AiConnectionResponse = {
  enabled: boolean;
  connection: AiConnection | null;
  observation: AiSessionObservation | null;
};

export type AiLoginAttempt = {
  id: string;
  state: 'WAITING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
  url?: string;
  expiresAt: string;
};
