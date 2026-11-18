import { getAccessToken } from "./auth.js";

const ENDPOINT = process.env.GAZELLE_GRAPHQL_URL ?? "https://gazelleapp.io/graphql/private";

export class GazelleApiError extends Error {}

export async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getAccessToken()}` },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401) {
    throw new GazelleApiError("Gazelle returned 401: token invalid/revoked. Re-run `npm run auth`.");
  }
  if (!res.ok) throw new GazelleApiError(`Gazelle GraphQL HTTP ${res.status}`);
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new GazelleApiError(body.errors.map((e) => e.message).join("; "));
  return body.data as T;
}

interface Connection<N> {
  nodes: N[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/**
 * Fetch all pages of a connection. `query` must declare `$after: String` and pass it
 * as `after:` to the connection field, and select `nodes` and `pageInfo { hasNextPage endCursor }`.
 * `pick` extracts the connection from the response.
 */
export async function gqlAll<T, N>(
  query: string,
  variables: Record<string, unknown>,
  pick: (data: T) => Connection<N>,
  maxPages = 200,
): Promise<N[]> {
  const out: N[] = [];
  let after: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const conn = pick(await gql<T>(query, { ...variables, after }));
    out.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) return out;
    after = conn.pageInfo.endCursor;
  }
  throw new GazelleApiError(`Pagination exceeded ${maxPages} pages`);
}
