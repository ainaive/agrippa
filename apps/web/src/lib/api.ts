export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type ApiInit = {
  method?: string;
  json?: unknown;
  headers?: Record<string, string>;
};

async function request<T>(url: string, init: ApiInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  let body: string | undefined;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers,
    body,
    credentials: "include",
  });
  if (!res.ok) {
    let code = "http_error";
    let message = res.statusText;
    let details: unknown;
    try {
      const parsed = (await res.json()) as { code?: string; message?: string; details?: unknown };
      code = parsed.code ?? code;
      message = parsed.message ?? message;
      details = parsed.details;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, code, message, details);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = <T>(path: string, init?: ApiInit) => request<T>(`/api/v1${path}`, init);

export const authApi = {
  signUp: (input: { name: string; email: string; password: string }) =>
    request<unknown>("/api/auth/sign-up/email", { method: "POST", json: input }),
  signIn: (input: { email: string; password: string }) =>
    request<unknown>("/api/auth/sign-in/email", { method: "POST", json: input }),
  signOut: () => request<unknown>("/api/auth/sign-out", { method: "POST", json: {} }),
};
