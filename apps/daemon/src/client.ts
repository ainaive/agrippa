import type {
  DaemonClaimResponse,
  DaemonProtocolHints,
  DaemonRegisterBody,
  DispatchCompleteBody,
  DispatchEventBatch,
  DispatchFailBody,
} from "@agrippa/core";

export type RegisterResponse = { runtimeId: string; hints: DaemonProtocolHints };

/**
 * The daemon's half of the wire (ADR-0017 Decision 3). Retries are bounded
 * and only where a replay is safe: event batches dedupe on (dispatch, seq)
 * server-side, register/heartbeat/claim are idempotent, and a complete/fail
 * replay that finds the dispatch already terminated treats the 409 as
 * success — the first attempt won.
 */
export interface DaemonApi {
  register(body: DaemonRegisterBody): Promise<RegisterResponse>;
  heartbeat(activeDispatchIds: string[]): Promise<void>;
  claim(waitSec: number): Promise<DaemonClaimResponse>;
  postEvents(dispatchId: string, batch: DispatchEventBatch["batch"]): Promise<{ abort: boolean }>;
  uploadArtifact(dispatchId: string, key: string, bytes: Uint8Array | string): Promise<void>;
  complete(dispatchId: string, body: DispatchCompleteBody): Promise<void>;
  fail(dispatchId: string, body: DispatchFailBody): Promise<void>;
}

const RETRIES = 3;
const BACKOFF_MS = 1000;

export class HttpDaemonApi implements DaemonApi {
  constructor(
    private readonly serverUrl: string,
    private readonly token: string,
  ) {}

  private async request<T>(
    method: string,
    apiPath: string,
    body?: unknown,
    opts?: { raw?: Uint8Array | string; tolerate409?: boolean },
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        const res = await fetch(`${this.serverUrl}/api/daemon${apiPath}`, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            ...(opts?.raw === undefined && body !== undefined
              ? { "content-type": "application/json" }
              : {}),
          },
          body:
            opts?.raw !== undefined
              ? opts.raw
              : body !== undefined
                ? JSON.stringify(body)
                : undefined,
        });
        if (res.status === 409 && opts?.tolerate409) return undefined as T;
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          // 4xx (auth, validation) never heals by retrying
          if (res.status < 500) throw new DaemonApiError(res.status, text);
          throw new RetryableError(`server ${res.status}: ${text.slice(0, 200)}`);
        }
        return (await res.json()) as T;
      } catch (err) {
        lastError = err;
        if (err instanceof DaemonApiError) throw err;
        if (attempt < RETRIES) await Bun.sleep(BACKOFF_MS * (attempt + 1));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  register(body: DaemonRegisterBody): Promise<RegisterResponse> {
    return this.request("POST", "/register", body);
  }
  async heartbeat(activeDispatchIds: string[]): Promise<void> {
    await this.request("POST", "/heartbeat", { activeDispatchIds });
  }
  claim(waitSec: number): Promise<DaemonClaimResponse> {
    return this.request("GET", `/claim?wait=${waitSec}`);
  }
  postEvents(dispatchId: string, batch: DispatchEventBatch["batch"]): Promise<{ abort: boolean }> {
    return this.request("POST", `/dispatches/${dispatchId}/events`, { batch });
  }
  async uploadArtifact(dispatchId: string, key: string, bytes: Uint8Array | string): Promise<void> {
    await this.request(
      "POST",
      `/dispatches/${dispatchId}/artifacts/${encodeURIComponent(key)}`,
      undefined,
      {
        raw: bytes,
      },
    );
  }
  async complete(dispatchId: string, body: DispatchCompleteBody): Promise<void> {
    await this.request("POST", `/dispatches/${dispatchId}/complete`, body, { tolerate409: true });
  }
  async fail(dispatchId: string, body: DispatchFailBody): Promise<void> {
    await this.request("POST", `/dispatches/${dispatchId}/fail`, body, { tolerate409: true });
  }
}

export class DaemonApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`daemon api ${status}: ${message.slice(0, 300)}`);
    this.name = "DaemonApiError";
  }
}

class RetryableError extends Error {}
