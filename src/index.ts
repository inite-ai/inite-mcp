import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { accessToken } from "./auth.js";

/**
 * The stdio side of the INITE visibility audit.
 *
 * This process defines no tools of its own. It asks https://inite.ai/api/mcp
 * what it offers and forwards calls there, so the tool list a client sees is
 * whatever the service actually implements today. A local copy of the schemas
 * would be a second source of truth, and the first thing it would do is drift.
 *
 * The SDK is used here and not on the server side, and the reason is only the
 * runtime: stdio is exactly what the SDK's transport is built for, while an
 * App Router handler is handed a Web `Request` that the HTTP transport cannot
 * drive.
 */

export const REMOTE = process.env.INITE_MCP_URL ?? "https://inite.ai/api/mcp";
export const VERSION = "1.0.0";

/** Thrown when the service says the caller has no usable token. */
export class NotSignedIn extends Error {
  constructor() {
    super(
      "Not signed in to inite.ai. Run `npx @inite/mcp login`, or set INITE_TOKEN in this server's environment.",
    );
  }
}

let nextId = 1;

/** One JSON-RPC round trip to the remote server. */
export async function remoteCall(
  method: string,
  params: Record<string, unknown> | undefined,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<any> {
  const res = await fetchImpl(REMOTE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "user-agent": `inite-mcp/${VERSION}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });

  if (res.status === 401) throw new NotSignedIn();
  if (!res.ok) throw new Error(`inite.ai answered ${res.status} for ${method}.`);

  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? `${method} failed.`);
  return body.result;
}

async function tokenOrThrow(): Promise<string> {
  const token = await accessToken();
  if (!token) throw new NotSignedIn();
  return token;
}

export async function main(): Promise<void> {
  const server = new Server(
    { name: "inite-visibility", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Listing is the first thing a client does, and failing it with an
    // exception makes the server look broken rather than signed out. An empty
    // list plus the reason on stderr is the honest shape.
    try {
      const token = await accessToken();
      if (!token) {
        process.stderr.write(`${new NotSignedIn().message}\n`);
        return { tools: [] };
      }
      return await remoteCall("tools/list", undefined, token);
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      return { tools: [] };
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const token = await tokenOrThrow();
      return await remoteCall(
        "tools/call",
        { name: req.params.name, arguments: req.params.arguments ?? {} },
        token,
      );
    } catch (e) {
      // A tool that failed is a result, not a crash: the model can read this
      // and tell the person what to do about it.
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
}
