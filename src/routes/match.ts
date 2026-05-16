/**
 * Tiny route-matcher. Built only because v0.2 has 12+ routes including path
 * params (`/api/ucp/v1/carts/:id`, `/api/acp/v1/checkout_sessions/:id`, etc.)
 * and we don't want to pull in Express / Hono just for this. ~30 lines.
 */

export interface MatchedRoute<H = unknown> {
  handler: H;
  params: Record<string, string>;
}

export interface RouteEntry<H> {
  method: string;
  pattern: string;     // e.g. "/api/ucp/v1/carts/:id"
  handler: H;
}

/**
 * Compile a pattern like "/a/b/:id/c" into a RegExp + param-name list.
 */
function compile(pattern: string): { re: RegExp; names: string[] } {
  const names: string[] = [];
  const re = new RegExp(
    "^" +
      pattern.replace(/\/:([^/]+)/g, (_m, name) => {
        names.push(name);
        return "/([^/?]+)";
      }) +
      "/?$",
  );
  return { re, names };
}

export class RouteTable<H> {
  private entries: Array<{ method: string; compiled: { re: RegExp; names: string[] }; handler: H; pattern: string }> = [];

  add(method: string, pattern: string, handler: H): void {
    this.entries.push({
      method: method.toUpperCase(),
      compiled: compile(pattern),
      handler,
      pattern,
    });
  }

  match(method: string, path: string): MatchedRoute<H> | null {
    const m = method.toUpperCase();
    for (const e of this.entries) {
      if (e.method !== m) continue;
      const r = e.compiled.re.exec(path);
      if (!r) continue;
      const params: Record<string, string> = {};
      e.compiled.names.forEach((n, i) => {
        params[n] = decodeURIComponent(r[i + 1] || "");
      });
      return { handler: e.handler, params };
    }
    return null;
  }

  /** List all registered patterns (used by /healthz or debug introspection). */
  list(): Array<{ method: string; pattern: string }> {
    return this.entries.map((e) => ({ method: e.method, pattern: e.pattern }));
  }
}
