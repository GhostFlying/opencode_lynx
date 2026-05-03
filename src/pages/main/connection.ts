import {
  connectCodexBackendClient,
  connectOpencodeBackendClient,
  createCodexBackendClientFromConnection,
  createOpencodeBackendClientFromConnection,
} from '../../backends/index.js';
import type { BackendClient, BackendConnectionState } from '../../backends/index.js';
import { storageGet, storageRemove, storageSet } from '../../storage.js';

const STORAGE_KEY = 'backend_connection';
const LEGACY_OPENCODE_STORAGE_KEY = 'opencode_connection';
const SAVED_CONNECTION_RETRY_DELAYS_MS = [0, 120, 320] as const;

export type ConnectionFormStatus = 'idle' | 'connecting' | 'error' | 'connected';

export type ConnectionTag = 'Online' | 'Connecting' | 'Offline' | 'Idle';

export type BackendKindLabel = 'opencode' | 'codex';

export interface OpencodeConnectionContext {
  kind: 'opencode';
  ip: string;
  port: string;
  password: string;
}

export interface CodexConnectionContext {
  kind: 'codex';
  host: string;
  port: string;
  token: string;
  secure: boolean;
}

export type ConnectionContext = OpencodeConnectionContext | CodexConnectionContext;

export interface ConnectionAttemptResult {
  client: BackendClient;
  connection: ConnectionContext;
  serverLabel: string;
}

export interface ConnectToBackendOptions {
  connectOpencode?: typeof connectOpencodeBackendClient;
  connectCodex?: typeof connectCodexBackendClient;
}

export interface CreateBackendClientFromConnectionOptions {
  createOpencode?: typeof createOpencodeBackendClientFromConnection;
  createCodex?: typeof createCodexBackendClientFromConnection;
}

export function isOpencodeConnection(
  connection: ConnectionContext
): connection is OpencodeConnectionContext {
  return connection.kind === 'opencode';
}

export function isCodexConnection(
  connection: ConnectionContext
): connection is CodexConnectionContext {
  return connection.kind === 'codex';
}

function isOpencodeUnion(value: unknown): value is OpencodeConnectionContext {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<OpencodeConnectionContext>;
  return (
    v.kind === 'opencode' &&
    typeof v.ip === 'string' &&
    typeof v.port === 'string'
  );
}

function isCodexUnion(value: unknown): value is CodexConnectionContext {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<CodexConnectionContext>;
  return (
    v.kind === 'codex' &&
    typeof v.host === 'string' &&
    typeof v.port === 'string'
  );
}

function isLegacyOpencode(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.ip === 'string' && typeof v.port === 'string';
}

function normalizeUnion(value: ConnectionContext): ConnectionContext {
  if (isOpencodeConnection(value)) {
    return {
      kind: 'opencode',
      ip: value.ip,
      port: value.port,
      password: typeof value.password === 'string' ? value.password : '',
    };
  }
  return {
    kind: 'codex',
    host: value.host,
    port: value.port,
    token: typeof value.token === 'string' ? value.token : '',
    secure: value.secure === true,
  };
}

function legacyToOpencode(value: unknown): OpencodeConnectionContext | null {
  if (!isLegacyOpencode(value)) return null;
  const v = value as Record<string, unknown>;
  return {
    kind: 'opencode',
    ip: v.ip as string,
    port: v.port as string,
    password: typeof v.password === 'string' ? v.password : '',
  };
}

function parseLooseLegacyOpencode(raw: string): OpencodeConnectionContext | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }

  const pairPattern = /([A-Za-z0-9_]+)\s*:\s*([^,}]*)/g;
  const parsed: Record<string, string> = {};
  let match: RegExpExecArray | null = null;

  while ((match = pairPattern.exec(trimmed)) !== null) {
    const key = match[1];
    const value = match[2]?.trim() ?? '';
    parsed[key] = value;
  }

  if (typeof parsed.ip !== 'string' || typeof parsed.port !== 'string') {
    return null;
  }

  return {
    kind: 'opencode',
    ip: parsed.ip,
    port: parsed.port,
    password: typeof parsed.password === 'string' ? parsed.password : '',
  };
}

export function defaultConnectionForKind(kind: BackendKindLabel): ConnectionContext {
  if (kind === 'codex') {
    return {
      kind: 'codex',
      host: '127.0.0.1',
      port: '7777',
      token: '',
      secure: false,
    };
  }
  return {
    kind: 'opencode',
    ip: '127.0.0.1',
    port: '3000',
    password: '',
  };
}

export function defaultConnection(): ConnectionContext {
  return defaultConnectionForKind('opencode');
}

export function cloneConnection(connection: ConnectionContext): ConnectionContext {
  if (isOpencodeConnection(connection)) {
    return {
      kind: 'opencode',
      ip: connection.ip,
      port: connection.port,
      password: connection.password,
    };
  }
  return {
    kind: 'codex',
    host: connection.host,
    port: connection.port,
    token: connection.token,
    secure: connection.secure,
  };
}

export function normalizeConnection(connection: ConnectionContext): ConnectionContext {
  if (isOpencodeConnection(connection)) {
    return {
      kind: 'opencode',
      ip: connection.ip.trim(),
      port: connection.port.trim(),
      password: connection.password,
    };
  }
  return {
    kind: 'codex',
    host: connection.host.trim(),
    port: connection.port.trim(),
    token: connection.token.trim(),
    secure: connection.secure,
  };
}

export async function readSavedConnection(): Promise<ConnectionContext | null> {
  const raw = await storageGet(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isOpencodeUnion(parsed) || isCodexUnion(parsed)) {
        return normalizeUnion(parsed);
      }
      // Stored under new key but missing kind — treat as legacy opencode shape.
      const legacyFromNewKey = legacyToOpencode(parsed);
      if (legacyFromNewKey) {
        return normalizeUnion(legacyFromNewKey);
      }
    } catch {
      // fall through to legacy read
    }
  }

  const legacyRaw = await storageGet(LEGACY_OPENCODE_STORAGE_KEY);
  if (!legacyRaw) {
    return null;
  }

  let legacyParsed: OpencodeConnectionContext | null = null;
  try {
    const parsed = JSON.parse(legacyRaw) as unknown;
    legacyParsed = legacyToOpencode(parsed);
  } catch {
    legacyParsed = parseLooseLegacyOpencode(legacyRaw);
  }

  if (!legacyParsed) {
    legacyParsed = parseLooseLegacyOpencode(legacyRaw);
  }

  if (!legacyParsed) {
    return null;
  }

  const migrated = normalizeUnion(legacyParsed);

  // Migration: write new key first, only remove legacy once new write succeeds.
  try {
    await storageSet(STORAGE_KEY, JSON.stringify(migrated));
    await storageRemove(LEGACY_OPENCODE_STORAGE_KEY);
  } catch {
    // best-effort: if persisting fails, preserve legacy data for next attempt.
  }

  return migrated;
}

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export async function readSavedConnectionWithRetry(): Promise<ConnectionContext | null> {
  for (const delayMs of SAVED_CONNECTION_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await waitForRetry(delayMs);
    }

    const saved = await readSavedConnection();
    if (saved) {
      return saved;
    }
  }

  return null;
}

export function saveConnection(connection: ConnectionContext): void {
  void storageSet(STORAGE_KEY, JSON.stringify(connection));
}

export function clearSavedConnection(): void {
  void storageRemove(STORAGE_KEY);
  void storageRemove(LEGACY_OPENCODE_STORAGE_KEY);
}

export function formatServerLabel(connection: ConnectionContext): string {
  if (isOpencodeConnection(connection)) {
    return `${connection.ip}:${connection.port}`;
  }
  const scheme = connection.secure ? 'wss' : 'ws';
  return `${scheme}://${connection.host}:${connection.port}`;
}

export function formatEndpoint(connection: ConnectionContext): string {
  if (isOpencodeConnection(connection)) {
    return `http://${connection.ip}:${connection.port}`;
  }
  return formatServerLabel(connection);
}

export function maskPassword(password: string): string {
  return password.length > 0 ? '•'.repeat(Math.min(password.length, 12)) : 'Not set';
}

export function maskCredential(connection: ConnectionContext): string {
  if (isOpencodeConnection(connection)) {
    return maskPassword(connection.password);
  }
  return maskPassword(connection.token);
}

export function connectionTagTone(tag: ConnectionTag): 'online' | 'warning' | 'offline' | 'idle' {
  switch (tag) {
    case 'Online':
      return 'online';
    case 'Connecting':
      return 'warning';
    case 'Offline':
      return 'offline';
    default:
      return 'idle';
  }
}

export function toConnectionTag(status: BackendConnectionState): ConnectionTag {
  switch (status) {
    case 'open':
      return 'Online';
    case 'connecting':
    case 'reconnecting':
      return 'Connecting';
    case 'stopped':
    case 'failed':
      return 'Offline';
    default:
      return 'Idle';
  }
}

export function validateConnection(connection: ConnectionContext): string | null {
  const normalized = normalizeConnection(connection);

  if (isOpencodeConnection(normalized)) {
    if (normalized.ip.length === 0) {
      return 'Server IP is required.';
    }
    const portNum = Number(normalized.port);
    if (!normalized.port || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return 'Port must be a number between 1 and 65535.';
    }
    return null;
  }

  if (normalized.host.length === 0) {
    return 'Server host is required.';
  }
  const portNum = Number(normalized.port);
  if (!normalized.port || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return 'Port must be a number between 1 and 65535.';
  }
  return null;
}

export async function connectToBackendClient(
  connection: ConnectionContext,
  options: ConnectToBackendOptions = {}
): Promise<ConnectionAttemptResult> {
  if (isOpencodeConnection(connection)) {
    const connect = options.connectOpencode ?? connectOpencodeBackendClient;
    const result = await connect(connection);
    const normalized: OpencodeConnectionContext = {
      kind: 'opencode',
      ip: result.connection.ip,
      port: result.connection.port,
      password: result.connection.password,
    };
    saveConnection(normalized);
    return {
      client: result.client,
      connection: normalized,
      serverLabel: result.serverLabel,
    };
  }

  const connect = options.connectCodex ?? connectCodexBackendClient;
  const result = await connect(connection);
  const normalized: CodexConnectionContext = {
    kind: 'codex',
    host: result.connection.host,
    port: result.connection.port,
    token: result.connection.token,
    secure: result.connection.secure,
  };
  saveConnection(normalized);
  return {
    client: result.client,
    connection: normalized,
    serverLabel: result.serverLabel,
  };
}

/**
 * Synchronous backend-client factory used by pages that already have a saved
 * `ConnectionContext` (e.g. the chat page) and just need a fresh client. Unlike
 * `connectToBackendClient`, this performs no network probe and does not save —
 * it dispatches by `connection.kind` to the matching backend factory.
 */
export function createBackendClientFromConnection(
  connection: ConnectionContext,
  options: CreateBackendClientFromConnectionOptions = {}
): BackendClient {
  if (isOpencodeConnection(connection)) {
    const create = options.createOpencode ?? createOpencodeBackendClientFromConnection;
    return create({
      ip: connection.ip,
      port: connection.port,
      password: connection.password,
    });
  }

  const create = options.createCodex ?? createCodexBackendClientFromConnection;
  return create({
    host: connection.host,
    port: connection.port,
    token: connection.token,
    secure: connection.secure,
  });
}
