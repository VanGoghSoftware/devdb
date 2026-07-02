export class EngineApiError extends Error {
  constructor(
    public operation: string,
    public status: number,
    public body: string,
  ) {
    super(`${operation}: engine returned ${status}: ${body}`);
  }
}

export async function engineFetch(
  operation: string,
  url: string,
  init: RequestInit = {},
  okStatuses: number[] = [200, 201, 202],
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  } catch (e) {
    throw new EngineApiError(operation, 0, String(e));
  }
  if (!okStatuses.includes(res.status)) {
    throw new EngineApiError(operation, res.status, await res.text());
  }
  return res;
}
