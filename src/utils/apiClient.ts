import type {
  ChannelDnaRecord,
  LlmHealthData,
  MasterPromptState,
  PipelineStateVector,
  ProjectItem,
  VaultKeyItem,
} from '../types/showrunner.ts';

const TOKEN_STORAGE_KEY = 'showrunner_bearer_token';
const PROJECT_STORAGE_KEY = 'showrunner_active_project_id';
const IDB_NAME = 'showrunner_v13_cache';
const IDB_STORE = 'state_snapshots';

export function getStoredBearerToken(): string {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setStoredBearerToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
  } catch {
    // Ignore storage quota errors
  }
}

export function getStoredProjectId(): string {
  try {
    return localStorage.getItem(PROJECT_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setStoredProjectId(projectId: string): void {
  try {
    localStorage.setItem(PROJECT_STORAGE_KEY, projectId.trim());
  } catch {
    // Ignore
  }
}

export class ApiClientError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly userMessage: string;
  public readonly retryable: boolean;
  public readonly raw?: string;
  public readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    options?: {
      userMessage?: string;
      retryable?: boolean;
      raw?: string;
      details?: unknown;
    }
  ) {
    super(options?.userMessage ?? message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.userMessage = options?.userMessage ?? message;
    this.retryable = Boolean(options?.retryable);
    this.raw = options?.raw;
    this.details = options?.details;
  }
}

export async function apiRequest<T>(
  path: string,
  options?: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
    projectId?: string | null;
  }
): Promise<T> {
  const token = getStoredBearerToken();
  const projectId = options?.projectId ?? getStoredProjectId();

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (options?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (projectId) {
    headers['X-Project-Id'] = projectId;
  }

  const requestBody =
    options?.body !== undefined
      ? typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body)
      : undefined;

  const response = await fetch(path, {
    method: options?.method ?? 'GET',
    headers,
    body: requestBody,
  });

  const json = (await response.json().catch(() => null)) as
    | { ok: true; data: T }
    | {
        ok: false;
        error: {
          code: string;
          message: string;
          userMessage?: string;
          retryable?: boolean;
          raw?: string;
          details?: unknown;
        };
      }
    | null;

  if (!response.ok || !json || json.ok === false) {
    const errObj = json && 'error' in json ? json.error : null;
    throw new ApiClientError(
      response.status,
      errObj?.code ?? `HTTP_${response.status}`,
      errObj?.userMessage ?? errObj?.message ?? `Request failed with status ${response.status}`,
      {
        userMessage: errObj?.userMessage ?? errObj?.message,
        retryable: errObj?.retryable,
        raw: errObj?.raw,
        details: errObj?.details,
      }
    );
  }

  return json.data;
}

export async function downloadBundleZip(projectId: string): Promise<void> {
  const token = getStoredBearerToken();
  const headers: Record<string, string> = {
    'X-Project-Id': projectId,
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`/api/v1/export/bundle?projectId=${encodeURIComponent(projectId)}`, {
    method: 'GET',
    headers,
  });

  if (!res.ok) {
    const errJson = (await res.json().catch(() => null)) as {
      error?: {
        code?: string;
        message?: string;
        userMessage?: string;
        retryable?: boolean;
        raw?: string;
        details?: unknown;
      };
    } | null;
    throw new ApiClientError(
      res.status,
      errJson?.error?.code ?? 'EXPORT_FAILED',
      errJson?.error?.userMessage ??
        errJson?.error?.message ??
        'Failed to download export bundle.',
      {
        userMessage: errJson?.error?.userMessage ?? errJson?.error?.message,
        retryable: errJson?.error?.retryable,
        raw: errJson?.error?.raw,
        details: errJson?.error?.details,
      }
    );
  }

  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match ? match[1] : `ShowRunner_OS_v1.3_${projectId}.zip`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ============================================================================
// INDEXEDDB FAST HYDRATION CACHE
// ============================================================================
export interface CachedPipelineSnapshot {
  mode: 'termux' | 'preview';
  showPreviewBanner: boolean;
  projects: ProjectItem[];
  activeProject: ProjectItem | null;
  stateVector: PipelineStateVector | null;
  channelDna?: ChannelDnaRecord | null;
  masterPromptState?: MasterPromptState | null;
  llmHealth?: LlmHealthData | null;
  keys: VaultKeyItem[];
}

function openCacheDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveCachedSnapshot(snapshot: CachedPipelineSnapshot): Promise<void> {
  const db = await openCacheDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(snapshot, 'latest');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function loadCachedSnapshot(): Promise<CachedPipelineSnapshot | null> {
  const db = await openCacheDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get('latest');
      req.onsuccess = () => resolve((req.result as CachedPipelineSnapshot) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
