export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ActorKind = 'human' | 'agent' | 'system';

export interface ActorIdentity {
  kind: ActorKind;
  id: string;
  displayName?: string;
}

export interface EventSource {
  runtime?: string;
  model?: string;
  sessionId?: string;
  repository?: string;
  commit?: string;
  workingDirectory?: string;
}

export type EvidenceKind = 'tool-call' | 'commit' | 'file' | 'url' | 'task' | 'note';

export interface EvidenceReference {
  kind: EvidenceKind;
  label?: string;
  value: string;
}

export interface AgentProfile {
  id: string;
  displayName: string;
  aliases?: string[];
  description?: string;
  createdAt: string;
  metadata?: Record<string, JsonValue>;
}

export interface BaseEvent {
  schemaVersion: 1;
  id: string;
  type: string;
  createdAt: string;
  actor: ActorIdentity;
  source?: EventSource;
  metadata?: Record<string, JsonValue>;
}

export interface KudosGivenEvent extends BaseEvent {
  type: 'kudos.given';
  recipientAgentId: string;
  recipientDisplayName: string;
  title: string;
  reason: string;
  evidence?: EvidenceReference[];
  tags?: string[];
  visibility: Visibility;
  idempotencyKey?: string;
}

export interface KudosAcknowledgedEvent extends BaseEvent {
  type: 'kudos.acknowledged';
  kudosId: string;
  recipientAgentId: string;
  note?: string;
}

export interface KudosRevokedEvent extends BaseEvent {
  type: 'kudos.revoked';
  kudosId: string;
  reason: string;
  mode: 'actor-requested' | 'administrative';
}

export interface AgentCreatedEvent extends BaseEvent {
  type: 'agent.created';
  agent: AgentProfile;
}

export interface AgentUpdatedEvent extends BaseEvent {
  type: 'agent.updated';
  agentId: string;
  changes: Partial<Omit<AgentProfile, 'id' | 'createdAt'>>;
}

export type KudosEvent =
  | KudosGivenEvent
  | KudosAcknowledgedEvent
  | KudosRevokedEvent
  | AgentCreatedEvent
  | AgentUpdatedEvent;

export type Visibility = 'private' | 'local' | 'public';
export type AcknowledgmentStatus = 'acknowledged' | 'unacknowledged';
export type RevocationStatus = 'revoked' | 'active';

export interface KudosRecord {
  event: KudosGivenEvent;
  acknowledgment?: KudosAcknowledgedEvent;
  revocation?: KudosRevokedEvent;
  status: AcknowledgmentStatus;
  revocationStatus: RevocationStatus;
}

export interface PaginationInput {
  limit?: number;
  offset?: number;
}

export interface KudosListInput extends PaginationInput {
  recipientAgentId?: string;
  actorId?: string;
  actorKind?: ActorKind;
  tag?: string;
  status?: AcknowledgmentStatus;
  visibility?: Visibility;
  revoked?: boolean;
  from?: string;
  to?: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface GiveKudosInput {
  recipientAgentId: string;
  title: string;
  reason: string;
  evidence?: EvidenceReference[];
  tags?: string[];
  visibility?: Visibility;
  idempotencyKey?: string;
  source?: EventSource;
  metadata?: Record<string, JsonValue>;
}

export interface GiveKudosResult {
  record: KudosRecord;
  created: boolean;
  deduplicated: boolean;
}

export interface CreateAgentInput {
  id: string;
  displayName: string;
  aliases?: string[];
  description?: string;
  metadata?: Record<string, JsonValue>;
}

export interface UpdateAgentInput {
  displayName?: string;
  aliases?: string[];
  description?: string;
  metadata?: Record<string, JsonValue>;
}

export interface KudosStats {
  total: number;
  active: number;
  acknowledged: number;
  revoked: number;
  byAgent: Record<string, number>;
  byActor: Record<string, number>;
  byTag: Record<string, number>;
}

export interface Diagnostic {
  level: 'ok' | 'warning' | 'error';
  code: string;
  message: string;
  path?: string;
}

export interface DoctorResult {
  healthy: boolean;
  diagnostics: Diagnostic[];
}

export interface AgentKudosConfig {
  schemaVersion: 1;
  defaultVisibility: Visibility;
  allowSelfAwards: boolean;
  allowAgentCreationViaMcp: boolean;
  allowRebuildViaMcp: boolean;
  includePrivateInStats: boolean;
  projection: {
    writeWinsMarkdown: boolean;
    writeInboxEntries: boolean;
  };
}

export type AgentKudosConfigOverrides = Omit<Partial<AgentKudosConfig>, 'projection'> & {
  projection?: Partial<AgentKudosConfig['projection']>;
};

export interface KudosClientOptions {
  home?: string;
  actor?: ActorIdentity;
  clock?: () => Date;
  idGenerator?: () => string;
  readOnly?: boolean;
  config?: AgentKudosConfigOverrides;
  signal?: AbortSignal;
}
