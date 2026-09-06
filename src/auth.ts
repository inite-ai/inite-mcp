import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Getting a token, and keeping it somewhere sane.
 *
 * The device flow is used rather than a loopback redirect because this process
 * has no browser and may not even be on the machine the person is sitting at —
 * an MCP server is often launched by a client, sometimes inside a container.
 * The device flow is the one grant designed for exactly that: print a code,
 * let the human finish somewhere else.
 *
 * The client registers itself dynamically on first login. `auth.inite.ai`
 * advertises a registration endpoint and accepts `token_endpoint_auth_method:
 * none`, so no secret is shipped in this package — which matters, because
 * anything published to npm is public by definition.
 */

const ISSUER = process.env.INITE_AUTH_URL ?? "https://auth-api.inite.ai";
const RESOURCE = process.env.INITE_MCP_URL ?? "https://inite.ai/api/mcp";
const SCOPES = "openid profile email offline_access";

export const TOKEN_PATH =
  process.env.INITE_TOKEN_FILE ?? join(homedir(), ".config", "inite", "mcp.json");

interface Stored {
  access_token: string;
  refresh_token?: string;
  /** Epoch millis. Absent when the server did not say. */
  expires_at?: number;
  client_id: string;
}

interface Metadata {
  registration_endpoint: string;
  device_authorization_endpoint: string;
  token_endpoint: string;
}

async function metadata(): Promise<Metadata> {
  const res = await fetch(`${ISSUER.replace(/\/$/, "")}/.well-known/oauth-authorization-server`);
  if (!res.ok) {
    // The well-known lives on the public host even when the API answers
    // elsewhere, so fall back before giving up.
    const alt = await fetch("https://auth.inite.ai/.well-known/oauth-authorization-server");
    if (!alt.ok) throw new Error(`Cannot read authorization server metadata (${res.status}).`);
    return (await alt.json()) as Metadata;
  }
  return (await res.json()) as Metadata;
}

async function save(t: Stored): Promise<void> {
  await mkdir(dirname(TOKEN_PATH), { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify(t, null, 2), "utf8");
  // The file holds a credential; nobody else on the machine needs to read it.
  await chmod(TOKEN_PATH, 0o600);
}

async function load(): Promise<Stored | null> {
  try {
    return JSON.parse(await readFile(TOKEN_PATH, "utf8")) as Stored;
  } catch {
    return null;
  }
}

async function registerClient(endpoint: string): Promise<string> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "INITE MCP (stdio)",
      grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
      token_endpoint_auth_method: "none",
      application_type: "native",
      scope: SCOPES,
    }),
  });
  if (!res.ok) throw new Error(`Client registration failed (${res.status}).`);
  const body = (await res.json()) as { client_id?: string };
  if (!body.client_id) throw new Error("Client registration returned no client_id.");
  return body.client_id;
}

/** Run the device flow, printing instructions to stderr. Returns nothing; the token is stored. */
export async function login(): Promise<void> {
  const meta = await metadata();
  const clientId = await registerClient(meta.registration_endpoint);

  const startRes = await fetch(meta.device_authorization_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPES, resource: RESOURCE }),
  });
  if (!startRes.ok) throw new Error(`Could not start the device flow (${startRes.status}).`);
  const start = (await startRes.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    interval?: number;
    expires_in?: number;
  };

  process.stderr.write(
    `\nOpen ${start.verification_uri_complete ?? start.verification_uri}\n` +
      (start.verification_uri_complete ? "" : `and enter the code: ${start.user_code}\n`) +
      `\nWaiting for you to approve…\n`,
  );

  const intervalMs = Math.max(1, start.interval ?? 5) * 1000;
  const deadline = Date.now() + (start.expires_in ?? 900) * 1000;

  for (;;) {
    if (Date.now() > deadline) throw new Error("The code expired before it was approved.");
    await new Promise((r) => setTimeout(r, intervalMs));

    const res = await fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: start.device_code,
        client_id: clientId,
        resource: RESOURCE,
      }),
    });
    const body = (await res.json()) as Record<string, any>;

    if (res.ok && body.access_token) {
      await save({
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        expires_at: body.expires_in ? Date.now() + body.expires_in * 1000 : undefined,
        client_id: clientId,
      });
      process.stderr.write(`Signed in. Token stored at ${TOKEN_PATH}\n`);
      return;
    }
    // `authorization_pending` and `slow_down` are the flow working as designed.
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") continue;
    throw new Error(`Sign-in failed: ${body.error_description ?? body.error ?? res.status}`);
  }
}

async function refresh(stored: Stored, meta: Metadata): Promise<Stored | null> {
  if (!stored.refresh_token) return null;
  const res = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: stored.refresh_token,
      client_id: stored.client_id,
      resource: RESOURCE,
    }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as Record<string, any>;
  if (!body.access_token) return null;
  const next: Stored = {
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? stored.refresh_token,
    expires_at: body.expires_in ? Date.now() + body.expires_in * 1000 : undefined,
    client_id: stored.client_id,
  };
  await save(next);
  return next;
}

/**
 * The token to send, or null.
 *
 * `INITE_TOKEN` wins when set: an environment variable is how an MCP client
 * config passes a credential, and how CI does it. The stored file is the
 * fallback, refreshed in place when it has expired.
 */
export async function accessToken(): Promise<string | null> {
  const fromEnv = process.env.INITE_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const stored = await load();
  if (!stored) return null;

  // A minute of slack: a token that expires mid-request is a failed call.
  if (stored.expires_at && stored.expires_at - 60_000 < Date.now()) {
    try {
      const next = await refresh(stored, await metadata());
      return next?.access_token ?? null;
    } catch {
      return null;
    }
  }
  return stored.access_token;
}
