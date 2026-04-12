import { createOpencodeGateway } from '../../opencode/gateway.js';
import type { OpenCodeGatewayContract } from '../../opencode/gateway.js';
import { storageGet, storageRemove, storageSet } from '../../storage.js';
import type { SseLifecycleStatus } from '../../opencode/events.js';

const STORAGE_KEY = 'opencode_connection';
const SAVED_CONNECTION_RETRY_DELAYS_MS = [0, 120, 320] as const;

export type ConnectionFormStatus = 'idle' | 'connecting' | 'error' | 'connected';

export type ConnectionTag = 'Online' | 'Connecting' | 'Offline' | 'Idle';

export interface ConnectionContext {
  ip: string;
  port: string;
  password: string;
}

export interface ConnectionAttemptResult {
  gateway: OpenCodeGatewayContract;
  connection: ConnectionContext;
  serverLabel: string;
}

function isSavedConnection(value: unknown): value is ConnectionContext {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ConnectionContext).ip === 'string' &&
    typeof (value as ConnectionContext).port === 'string'
  );
}

function normalizeSavedConnection(value: ConnectionContext): ConnectionContext {
  return {
    ip: value.ip,
    port: value.port,
    password: typeof value.password === 'string' ? value.password : '',
  };
}

function parseLooseSavedConnection(raw: string): ConnectionContext | null {
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
    ip: parsed.ip,
    port: parsed.port,
    password: typeof parsed.password === 'string' ? parsed.password : '',
  };
}

export function defaultConnection(): ConnectionContext {
  return {
    ip: '127.0.0.1',
    port: '3000',
    password: '',
  };
}

export function cloneConnection(connection: ConnectionContext): ConnectionContext {
  return {
    ip: connection.ip,
    port: connection.port,
    password: connection.password,
  };
}

export function normalizeConnection(connection: ConnectionContext): ConnectionContext {
  return {
    ip: connection.ip.trim(),
    port: connection.port.trim(),
    password: connection.password,
  };
}

export async function readSavedConnection(): Promise<ConnectionContext | null> {
  const raw = await storageGet(STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isSavedConnection(parsed)) {
      return parseLooseSavedConnection(raw);
    }

    return normalizeSavedConnection(parsed);
  } catch {
    return parseLooseSavedConnection(raw);
  }
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
}

export function formatServerLabel(connection: ConnectionContext): string {
  return `${connection.ip}:${connection.port}`;
}

export function formatEndpoint(connection: ConnectionContext): string {
  return `http://${connection.ip}:${connection.port}`;
}

export function maskPassword(password: string): string {
  return password.length > 0 ? '•'.repeat(Math.min(password.length, 12)) : 'Not set';
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

export function toConnectionTag(status: SseLifecycleStatus): ConnectionTag {
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
  if (normalized.ip.length === 0) {
    return 'Server IP is required.';
  }

  const portNum = Number(normalized.port);
  if (!normalized.port || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return 'Port must be a number between 1 and 65535.';
  }

  return null;
}

export async function connectToGateway(
  connection: ConnectionContext
): Promise<ConnectionAttemptResult> {
  const normalized = normalizeConnection(connection);
  const validationError = validateConnection(normalized);
  if (validationError) {
    throw new Error(validationError);
  }

  const gateway = createOpencodeGateway({
    baseUrl: formatEndpoint(normalized),
    ...(normalized.password ? { auth: normalized.password } : {}),
  });

  await gateway.sessions.list();
  saveConnection(normalized);

  return {
    gateway,
    connection: normalized,
    serverLabel: formatServerLabel(normalized),
  };
}
