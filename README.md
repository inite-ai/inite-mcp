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

## Works before you sign in

Three of the tools run entirely on your machine — a `robots.txt` fetched, a
file probed for, a page parsed. No account, no allowance, no call home.

```
> Is anything blocking AI crawlers on stripe.com?

  check_ai_access(url: "stripe.com")

  Retrieval: all 7 answer-engine crawlers may fetch the site.
  Training:  3 of 8 blocked — Meta-ExternalAgent, Bytespider, Amazonbot.
```

Signing in adds the two that cost something real: the answer engines are
actually asked whether they name the site, and the eight weighted sections are
scored.

## Install

**Claude Desktop, Cursor, or any client that launches a stdio server:**

```json
{
  "mcpServers": {
    "inite": {
      "command": "npx",
      "args": ["-y", "@inite/visibility"]
    }
  }
}
```

Then sign in once:

```sh
npx @inite/visibility login
```

That opens a browser, you approve, and the token is stored at
`~/.config/inite/mcp.json` with owner-only permissions. Authorization code with
PKCE over a loopback redirect, the flow RFC 8252 prescribes for a native app.
Nothing is written to the repository and no secret ships in the package.

**Already have a token** (CI, a shared config, a container):

```json
{
  "mcpServers": {
    "inite": {
      "command": "npx",
      "args": ["-y", "@inite/visibility"],
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

**Local — no account:**

| tool | what it does |
|---|---|
| `check_ai_access(url)` | Which AI crawlers `robots.txt` lets in, separating the ones that fetch a page to answer a live question from the ones that only collect training data. Blocking the first kind is what makes a site invisible; blocking the second costs nothing. |
| `check_identity_files(url)` | Which of the ten identity files exist — `llms.txt`, `ai.json`, `identity.json` and the rest. |
| `check_page_signals(url)` | Title, description, canonical, hreflang, and the Schema.org types in the page's JSON-LD. |

**Remote — needs an account:**

| tool | what it does |
|---|---|
| `analyze_site(url)` | Starts the full audit and returns a `run_id`. Takes about a minute. |
| `get_analysis(run_id)` | Progress while it runs; the score out of 100 and the report address once it finishes. |

Two tools rather than one for the audit, because it is asynchronous. A single
tool that blocked for a minute would be torn down by most clients' timeouts.

## Commands

```
inite-visibility            run as an MCP server over stdio (what a client does)
inite-visibility login      sign in through the browser
inite-visibility whoami     say whether a usable token is present
```

## What this package is

Two halves.

The local checks are real work done here: fetching, parsing, and the robots
rules applied properly — most-specific group wins, longest matching rule wins,
`Allow` breaks a tie. They cost nobody anything because your machine does them.

The remote half defines no schemas of its own. It asks `inite.ai` what it
offers and forwards calls there, so that tool list is whatever the service
implements today. A local copy would be a second source of truth, and the first
thing it would do is drift.

What stays on the server is what costs something or is ours: four answer
engines asked whether they name a site, and the weights that turn everything
into one number. The local tools report facts; `analyze_site` reports a score.

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

## A note on the command name

`npx @inite/visibility` resolves because there is exactly one binary in the
package. npm looks for a command matching the package name with the scope
stripped — `visibility` — does not find it, and runs the only one there is.

The binary is called `inite-visibility` rather than `visibility` on purpose: a
scoped package has no business claiming a word that general in your `PATH` on
a global install. The cost is that a second binary would break the line above
for every client, so a test pins it at one.

If you are invoking it from a directory that contains this package's own
`package.json`, npm prefers the local copy and finds no linked command. Name it
explicitly there:

```sh
npx -p @inite/visibility inite-visibility login
```

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
