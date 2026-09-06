import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Getting a token, and keeping it somewhere sane.
 *
 * Authorization code with PKCE over a loopback redirect — the flow RFC 8252
 * prescribes for a native app, and the only interactive one this service will
 * grant a dynamically registered client.
 *
 * The device flow would have suited a process that may not run on the person's
 * own machine, and it was written first. It does not work: checked against
 * auth.inite.ai on 2026-09-05, dynamic registration allows exactly
 * `authorization_code`, `refresh_token` and `client_credentials`, and quietly
 * drops anything else — asking for `device_code` returns 201 with
 * `grant_types: ["refresh_token"]`, and the device endpoint then refuses the
 * client it just issued. A silent narrowing is legal under RFC 7591, which is
 * exactly why it has to be read out of the response rather than assumed.
 *
 * The client registers itself on first login and ships no secret, because
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
  authorization_endpoint: string;
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

const b64url = (b: Buffer) => b.toString("base64url");

/**
 * Register for this login only.
 *
 * The redirect URI has to name the port before the browser is sent anywhere,
 * so the loopback listener is opened first and its port passed in here. A
 * client is cheap and short-lived; the service reaps unused `dcr_` rows on its
 * own.
 *
 * The granted grants are read back rather than assumed. RFC 7591 permits a
 * server to narrow what it issues, and this one does it silently — that is how
 * the first version of this file ended up asking for a grant it had been told,
 * with a 201, that it did not have.
 */
async function registerClient(endpoint: string, redirectUri: string): Promise<string> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "INITE MCP (stdio)",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
      redirect_uris: [redirectUri],
      scope: SCOPES,
    }),
  });
  if (!res.ok) throw new Error(`Client registration failed (${res.status}).`);
  const body = (await res.json()) as { client_id?: string; grant_types?: string[] };
  if (!body.client_id) throw new Error("Client registration returned no client_id.");
  if (body.grant_types && !body.grant_types.includes("authorization_code")) {
    throw new Error(
      `The authorization server registered this client without the authorization_code grant (got: ${body.grant_types.join(", ") || "none"}). Sign-in cannot continue.`,
    );
  }
  return body.client_id;
}

/** Open a URL in whatever the platform uses, and shrug if it cannot. */
function openBrowser(url: string): void {
  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true, shell: platform() === "win32" }).unref();
  } catch {
    // Printed below either way; a headless box just uses the printed link.
  }
}

/** Listen on an ephemeral loopback port and resolve with the first code that arrives. */
function waitForCode(expectedState: string): Promise<{ port: number; code: Promise<string> }> {
  return new Promise((resolveReady, rejectReady) => {
    let settle: (code: string) => void;
    let fail: (e: Error) => void;
    const code = new Promise<string>((res, rej) => {
      settle = res;
      fail = rej;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const got = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });

      if (error) {
        res.end(`<p>Sign-in failed: ${error}. You can close this tab.</p>`);
        server.close();
        return fail(new Error(`Authorization failed: ${error}`));
      }
      // State is the only thing standing between this listener and a code
      // some other page in the browser was tricked into sending here.
      if (!got || state !== expectedState) {
        res.end("<p>Unexpected response. You can close this tab.</p>");
        return;
      }
      res.end("<p>Signed in to INITE. You can close this tab.</p>");
      server.close();
      settle(got);
    });

    server.on("error", rejectReady);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "string" || !addr) return rejectReady(new Error("No loopback port."));
      // A browser that never comes back must not hang the terminal forever.
      const timer = setTimeout(() => {
        server.close();
        fail(new Error("Timed out waiting for the browser."));
      }, 5 * 60_000);
      void code.finally(() => clearTimeout(timer));
      resolveReady({ port: addr.port, code });
    });
  });
}

/** Sign in through the browser. Returns nothing; the token is stored. */
export async function login(): Promise<void> {
  const meta = await metadata();

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));

  const { port, code } = await waitForCode(state);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const clientId = await registerClient(meta.registration_endpoint, redirectUri);

  const authUrl = new URL(meta.authorization_endpoint);
  authUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    // RFC 8707. This is what puts inite.ai/api/mcp in the token's audience,
    // which is the only audience that endpoint accepts.
    resource: RESOURCE,
  }).toString();

  process.stderr.write(`\nOpening your browser to sign in.\nIf it does not open:\n\n  ${authUrl}\n\n`);
  openBrowser(authUrl.toString());

  const authCode = await code;

  const res = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authCode,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    }),
  });
  const body = (await res.json()) as Record<string, any>;
  if (!res.ok || !body.access_token) {
    throw new Error(`Sign-in failed: ${body.error_description ?? body.error ?? res.status}`);
  }

  await save({
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: body.expires_in ? Date.now() + body.expires_in * 1000 : undefined,
    client_id: clientId,
  });
  process.stderr.write(`Signed in. Token stored at ${TOKEN_PATH}\n`);
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
