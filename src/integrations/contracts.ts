export const BUILT_IN_INTEGRATION_NAMES = [
  "claude",
  "claude-sync",
  "codex",
] as const;

export type BuiltInIntegrationName =
  (typeof BUILT_IN_INTEGRATION_NAMES)[number];

export type MaybePromise<T> = T | Promise<T>;

export interface BridgeMessage {
  type: string;
  [key: string]: unknown;
}

export type EmitBridgeMessage = (
  sessionId: string | undefined,
  message: BridgeMessage,
) => void;

export interface IntegrationSession {
  id: string;
  title?: string;
  timestamp?: string;
  cwd?: string;
  provider?: string;
  status?: string | null;
  [key: string]: unknown;
}

export interface IntegrationInfo {
  provider: string;
  account?: Record<string, unknown>;
  model?: string;
  version?: string;
  [key: string]: unknown;
}

export interface IntegrationHistoryMessage {
  role: string;
  text: string;
  [key: string]: unknown;
}

export interface IntegrationPromptResult {
  sessionId: string;
  provider: string;
}

export interface IntegrationStatus {
  state: string;
  provider: string;
  [key: string]: unknown;
}

export interface CliIntegration {
  listSessions(
    limit: number,
    cwd?: string,
  ): MaybePromise<IntegrationSession[]>;
  getSessionStatus(sessionId: string): MaybePromise<string>;
  getInfo(): MaybePromise<IntegrationInfo>;
  getHistory(
    sessionId: string,
    limit: number,
  ): MaybePromise<IntegrationHistoryMessage[]>;
  prompt(
    sessionId: string | undefined,
    text: string,
    cwd?: string,
  ): MaybePromise<IntegrationPromptResult>;
  respondPermission(
    sessionId: string,
    decision: string,
  ): boolean | void;
  respondQuestion(
    sessionId: string,
    answer: unknown,
  ): boolean | void;
  interrupt(sessionId: string): MaybePromise<void>;
  getStatus(sessionId: string): IntegrationStatus | null | undefined;
}

export interface NamedCliIntegration<Name extends string = string> {
  name: Name;
  integration: CliIntegration;
}
