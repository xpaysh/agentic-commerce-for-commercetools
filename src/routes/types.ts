export interface RouteRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** Path-param map populated by the route matcher (e.g. `{id: "..."}`). */
  params?: Record<string, string>;
  /** Raw request body. POST/PATCH handlers parse this; GET handlers ignore. */
  body?: string;
}

export interface RouteResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type RouteHandler = (req: RouteRequest) => Promise<RouteResponse>;
