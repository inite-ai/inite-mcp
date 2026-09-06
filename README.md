# INITE MCP — AI visibility, from inside your agent

Ask your assistant whether the answer engines can see a website, and get a
number back.

```
> Can ChatGPT actually find stripe.com, or is it invisible?

  analyze_site(url: "stripe.com")   → run_id: cm4x…
  get_analysis(run_id: "cm4x…")     → Score: 78/100
```

The audit reads a live site the way an assistant does — the identity files an
engine looks for (`llms.txt`, `ai.json` and the rest), the crawler policy, the
schema graph, page health — and then asks Claude, ChatGPT, Gemini and
Perplexity whether they name it. One score out of 100 across eight weighted
sections.

It is the same audit that runs at [inite.ai/en/analyze](https://inite.ai/en/analyze).

## Install

**Claude Desktop, Cursor, or any client that launches a stdio server:**

```json
{
  "mcpServers": {
    "inite": {
      "command": "npx",
      "args": ["-y", "@inite/mcp"]
    }
  }
}
```

Then sign in once:

```sh
npx @inite/mcp login
```

That opens a browser, you approve, and the token is stored at
`~/.config/inite/mcp.json` with owner-only permissions. Nothing is written to
the repository and no secret ships in the package.

**Already have a token** (CI, a shared config, a container):

```json
{
  "mcpServers": {
    "inite": {
      "command": "npx",
      "args": ["-y", "@inite/mcp"],
      "env": { "INITE_TOKEN": "…" }
    }
  }
}
```

`INITE_TOKEN` wins over the stored file.

**Client speaks the MCP authorization flow?** Skip this package. Point it
straight at `https://inite.ai/api/mcp` and it will discover the rest: an
unauthenticated call answers `401` with `WWW-Authenticate` naming
[the protected-resource metadata](https://inite.ai/.well-known/oauth-protected-resource),
which names the authorization server.

## Tools

| tool | what it does |
|---|---|
| `analyze_site(url)` | Starts an audit and returns a `run_id`. Takes about a minute. |
| `get_analysis(run_id)` | Progress while it runs; the score and the report address once it finishes. |

Two tools rather than one, because the audit is asynchronous. A single tool
that blocked for a minute would be torn down by most clients' timeouts.

## Commands

```
inite-mcp            run as an MCP server over stdio (what a client does)
inite-mcp login      sign in through the browser
inite-mcp whoami     say whether a usable token is present
```

## What this package is

A bridge, and deliberately a thin one. It defines no tools of its own: it asks
`inite.ai` what it offers and forwards calls there, so the tool list your
client sees is whatever the service implements today. A local copy of the
schemas would be a second source of truth, and the first thing it would do is
drift.

## Account and allowance

An audit spends real work — fetches, and model calls across four answer
engines — so it runs against an account rather than anonymously. The daily
allowance and the depth of the report are your plan's own, exactly as on the
website: a free account gets the teaser tier, a paid one the full pipeline.
[Plans are here](https://inite.ai/en/pricing).

## Environment

| variable | meaning |
|---|---|
| `INITE_TOKEN` | Use this token instead of the stored one. |
| `INITE_MCP_URL` | Point at a different endpoint. Default `https://inite.ai/api/mcp`. |
| `INITE_TOKEN_FILE` | Where the token lives. Default `~/.config/inite/mcp.json`. |
| `INITE_AUTH_URL` | Authorization server. Default `https://auth-api.inite.ai`. |

## Development

```sh
npm install
npm run build
npm test
```

The tests cover what the bridge can get wrong without saying so: dropping the
credential, turning "signed out" into "broken", swallowing an error into a
success, and letting a stale file beat the environment.

## Licence

MIT. The service it talks to is [INITE](https://inite.ai).
