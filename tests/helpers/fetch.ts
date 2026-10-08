export interface Call { url: string; init: RequestInit }
export type Route = (call: Call) => Response | Promise<Response>;

export function makeFetch(route: Route, calls: Call[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return route(call);
  }) as typeof fetch;
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
