export interface RouteRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
}

export interface RouteResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type RouteHandler = (req: RouteRequest) => Promise<RouteResponse>;
