/**
 * Thin commercetools REST client. Uses raw `fetch` (Node 18+) and the
 * client_credentials OAuth flow. Caches the bearer token in-memory and
 * refreshes on expiry or 401.
 *
 * We intentionally avoid pulling in @commercetools/platform-sdk +
 * @commercetools/sdk-client-v2 + middleware packages for v0.1 — keeps the
 * service to a 4-dep install (just the @xpaysh/* packages) and demonstrates
 * the adapter pattern doesn't require any particular SDK. Forks that want
 * type-safe queries can swap this module for the SDK without touching the
 * adapter or routes layer.
 */

import type { CommercetoolsCredentials } from "./config";

interface CachedToken {
  accessToken: string;
  expiresAt: number; // unix seconds
}

export class CommercetoolsClient {
  private creds: CommercetoolsCredentials;
  private token: CachedToken | null = null;
  /** Refresh slightly before actual expiry to avoid races. */
  private refreshSkewSeconds = 60;

  constructor(creds: CommercetoolsCredentials) {
    this.creds = creds;
  }

  /**
   * Fetch a project-scoped API path. Adds bearer auth + JSON content-type;
   * automatically retries once on 401 by refreshing the token.
   */
  async fetchJson<T = unknown>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    const url = this.projectUrl(path);
    const token = await this.getToken();
    const headers = new Headers(init.headers || {});
    headers.set("authorization", `Bearer ${token}`);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    headers.set("accept", "application/json");

    const resp = await fetch(url, { ...init, headers });

    if (resp.status === 401 && retry) {
      // Force-refresh token + one retry
      this.token = null;
      return this.fetchJson<T>(path, init, false);
    }

    if (!resp.ok) {
      const body = await safeRead(resp);
      throw new CommercetoolsError(`commercetools ${resp.status} ${resp.statusText} for ${url}`, resp.status, body);
    }

    if (resp.status === 204) return undefined as unknown as T;
    return (await resp.json()) as T;
  }

  private projectUrl(path: string): string {
    const base = this.creds.apiUrl.replace(/\/$/, "");
    const projectPath = `/${this.creds.projectKey}${path.startsWith("/") ? path : "/" + path}`;
    return base + projectPath;
  }

  private async getToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && this.token.expiresAt - this.refreshSkewSeconds > now) {
      return this.token.accessToken;
    }
    return this.refreshToken();
  }

  private async refreshToken(): Promise<string> {
    const url = `${this.creds.authUrl.replace(/\/$/, "")}/oauth/token`;
    const auth = Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`, "utf8").toString("base64");
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      scope: this.creds.scope,
    });
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Basic ${auth}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!resp.ok) {
      const detail = await safeRead(resp);
      throw new CommercetoolsError(`commercetools oauth ${resp.status} ${resp.statusText}`, resp.status, detail);
    }
    const parsed = (await resp.json()) as { access_token: string; expires_in: number };
    if (!parsed.access_token) {
      throw new CommercetoolsError("commercetools oauth: response missing access_token", 0, parsed);
    }

    const now = Math.floor(Date.now() / 1000);
    this.token = {
      accessToken: parsed.access_token,
      expiresAt: now + (parsed.expires_in || 1800),
    };
    return parsed.access_token;
  }
}

export class CommercetoolsError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "CommercetoolsError";
    this.status = status;
    this.body = body;
  }
}

async function safeRead(resp: Response): Promise<unknown> {
  try {
    const ct = resp.headers.get("content-type") || "";
    if (ct.includes("application/json")) return await resp.json();
    return await resp.text();
  } catch {
    return null;
  }
}
