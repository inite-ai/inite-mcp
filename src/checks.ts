/**
 * The half of the audit that costs nobody anything.
 *
 * Fetching a robots.txt, probing for a file, reading the JSON-LD out of a page
 * — all of that is HTTP and parsing, and it runs on the machine of whoever
 * installed this. So it needs no account and no allowance: the work is theirs.
 *
 * What stays on the server is what actually costs something or is ours: asking
 * four answer engines whether they name a site, and the weights that turn all
 * of it into one number. These tools report facts; `analyze_site` reports a
 * score.
 *
 * The bot names and the file paths below are public — published user-agent
 * strings and proposed conventions. The weights behind them are not, and are
 * deliberately absent.
 */

/** Crawlers that fetch a page to answer a live question. Blocking these costs visibility. */
export const RETRIEVAL_BOTS = [
  "Bingbot",
  "OAI-SearchBot",
  "PerplexityBot",
  "ChatGPT-User",
  "Claude-SearchBot",
  "Perplexity-User",
  "Claude-User",
] as const;

/** Crawlers that collect training data. Blocking these costs nothing today. */
export const TRAINING_BOTS = [
  "GPTBot",
  "ClaudeBot",
  "Google-Extended",
  "CCBot",
  "Applebot-Extended",
  "Meta-ExternalAgent",
  "Bytespider",
  "Amazonbot",
] as const;

/** Files an engine may look for when working out who a site belongs to. */
export const IDENTITY_FILES = [
  "/llms.txt",
  "/ai.json",
  "/ai.txt",
  "/identity.json",
  "/llm.txt",
  "/llms.html",
  "/brand.txt",
  "/developer-ai.txt",
  "/faq-ai.txt",
  "/robots-ai.txt",
] as const;

const UA = "inite-mcp (+https://inite.ai)";
const TIMEOUT_MS = 10_000;

/**
 * Only the public web, even though this runs locally.
 *
 * A model can be talked into things, and "fetch http://192.168.1.1/" from a
 * tool running on somebody's laptop is a port scan of their own network with
 * extra steps.
 */
export function publicUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const withScheme = /^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
  try {
    const u = new URL(withScheme);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (!u.hostname.includes(".")) return null;
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1|\[)/i.test(u.hostname)) return null;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)) return null;
    return u;
  } catch {
    return null;
  }
}

async function get(url: string): Promise<{ status: number; body: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: res.status, body: res.status === 200 ? await res.text() : "" };
  } catch {
    return null;
  }
}

// ─── robots.txt ───────────────────────────────────────────────────────────────

interface Group {
  agents: string[];
  rules: { allow: boolean; path: string }[];
}

/**
 * Parse robots.txt into agent groups.
 *
 * Deliberately not a full implementation: no crawl-delay, no sitemap, no
 * wildcard expansion beyond a leading match. It answers one question — is this
 * agent allowed to fetch the root — and says so rather than pretending to more.
 */
export function parseRobots(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      // Consecutive User-agent lines share one group of rules.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "allow" || field === "disallow") {
      current.rules.push({ allow: field === "allow", path: value });
    }
  }
  return groups;
}

/** Whether `agent` may fetch `path`, by the most specific group that names it. */
export function isAllowed(groups: Group[], agent: string, path = "/"): boolean {
  const lower = agent.toLowerCase();
  const named = groups.find((g) => g.agents.includes(lower));
  const wildcard = groups.find((g) => g.agents.includes("*"));
  const group = named ?? wildcard;
  if (!group) return true;

  // Longest matching rule wins; Allow beats Disallow at equal length.
  let best: { allow: boolean; len: number } | null = null;
  for (const rule of group.rules) {
    if (rule.path === "") continue;
    if (!path.startsWith(rule.path.replace(/\*$/, ""))) continue;
    const len = rule.path.length;
    if (!best || len > best.len || (len === best.len && rule.allow)) {
      best = { allow: rule.allow, len };
    }
  }
  // An empty Disallow means "allow everything" and is handled by the skip above.
  return best ? best.allow : true;
}

export async function checkAiAccess(site: URL): Promise<string> {
  const robots = await get(new URL("/robots.txt", site).toString());
  if (!robots) return `Could not reach ${site.hostname}.`;
  if (robots.status !== 200) {
    return [
      `${site.hostname} has no robots.txt (HTTP ${robots.status}).`,
      ``,
      `Nothing is blocked, which is the permissive default. It also means no`,
      `crawler is being told anything on purpose.`,
    ].join("\n");
  }

  const groups = parseRobots(robots.body);
  const blockedRetrieval = RETRIEVAL_BOTS.filter((b) => !isAllowed(groups, b));
  const blockedTraining = TRAINING_BOTS.filter((b) => !isAllowed(groups, b));

  const lines = [`Crawler policy for ${site.hostname}`, ``];

  lines.push(
    blockedRetrieval.length === 0
      ? `Retrieval: all ${RETRIEVAL_BOTS.length} answer-engine crawlers may fetch the site.`
      : `Retrieval: ${blockedRetrieval.length} of ${RETRIEVAL_BOTS.length} blocked — ${blockedRetrieval.join(", ")}.`,
  );
  if (blockedRetrieval.length) {
    lines.push(
      `These are the ones that fetch a page to answer a live question. Blocking`,
      `them is what makes a site invisible in AI answers, whatever its search rank.`,
    );
  }

  lines.push(``);
  lines.push(
    blockedTraining.length === 0
      ? `Training: none of the ${TRAINING_BOTS.length} training crawlers are blocked.`
      : `Training: ${blockedTraining.length} of ${TRAINING_BOTS.length} blocked — ${blockedTraining.join(", ")}.`,
  );
  lines.push(
    `Training crawlers collect corpus data. Blocking them costs no visibility`,
    `today, whatever a checklist says — they are a separate decision.`,
  );

  return lines.join("\n");
}

// ─── identity files ───────────────────────────────────────────────────────────

export async function checkIdentityFiles(site: URL): Promise<string> {
  const results = await Promise.all(
    IDENTITY_FILES.map(async (path) => {
      const res = await get(new URL(path, site).toString());
      // A site that answers 200 to everything tells you nothing; a body that is
      // clearly a page rather than the file is the usual way that shows up.
      const looksLikeHtml = /^\s*<(!doctype|html)/i.test(res?.body ?? "");
      return { path, found: res?.status === 200 && !looksLikeHtml, bytes: res?.body.length ?? 0 };
    }),
  );

  const found = results.filter((r) => r.found);
  const lines = [
    `Identity files on ${site.hostname}: ${found.length} of ${IDENTITY_FILES.length}`,
    ``,
  ];
  for (const r of results) {
    lines.push(`  ${r.found ? "yes" : " no"}  ${r.path}${r.found ? `  (${r.bytes} bytes)` : ""}`);
  }
  lines.push(``);
  lines.push(
    found.length === 0
      ? `None of these are a ranking factor, and none are required. They are how a`
      : `None of these are a ranking factor. They are how a`,
    `site states plainly who it is, for an engine that would otherwise guess from`,
    `the page. /llms.txt is the one with the most adoption.`,
  );
  return lines.join("\n");
}

// ─── page signals ─────────────────────────────────────────────────────────────

function jsonLdTypes(html: string): string[] {
  const types = new Set<string>();
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try {
      const parsed = JSON.parse(m[1]!);
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (node && typeof node === "object") {
          const t = (node as Record<string, unknown>)["@type"];
          if (typeof t === "string") types.add(t);
          if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && types.add(x));
          if (Array.isArray((node as Record<string, unknown>)["@graph"])) {
            walk((node as Record<string, unknown>)["@graph"]);
          }
        }
      };
      walk(parsed);
    } catch {
      // A block that does not parse is a finding of its own, reported below.
      types.add("(unparseable JSON-LD)");
    }
  }
  return [...types];
}

const meta = (html: string, re: RegExp): string | null => html.match(re)?.[1]?.trim() ?? null;

export async function checkPageSignals(site: URL): Promise<string> {
  const page = await get(site.toString());
  if (!page) return `Could not reach ${site.hostname}.`;
  if (page.status !== 200) return `${site} answered HTTP ${page.status}.`;

  const html = page.body;
  const title = meta(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = meta(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
  const canonical = meta(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i);
  const types = jsonLdTypes(html);
  // Deduplicated, but the repeat count is kept: the same hreflang declared
  // twice is a finding, not noise to hide.
  const hreflangRaw = [...html.matchAll(/<link[^>]+rel=["']alternate["'][^>]+hreflang=["']([^"']*)["']/gi)]
    .map((m) => m[1])
    .filter((x): x is string => Boolean(x));
  const counts = new Map<string, number>();
  for (const h of hreflangRaw) counts.set(h, (counts.get(h) ?? 0) + 1);
  const hreflang = [...counts].map(([tag, n]) => (n > 1 ? `${tag} (×${n})` : tag));

  return [
    `Page signals for ${site.hostname}`,
    ``,
    `  title        ${title ?? "— missing"}`,
    `  description  ${description ?? "— missing"}`,
    `  canonical    ${canonical ?? "— missing"}`,
    `  hreflang     ${hreflang.length ? hreflang.join(", ") : "— none"}`,
    `  schema.org   ${types.length ? types.join(", ") : "— no JSON-LD found"}`,
    ``,
    types.length
      ? `An engine reads the graph before it reads the prose. Organization and`
      : `Without JSON-LD an engine has only the prose to work from, and has to`,
    types.length
      ? `WebSite are the two that answer "who is this".`
      : `infer who the site belongs to.`,
  ].join("\n");
}
