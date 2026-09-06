#!/usr/bin/env node
import { login, TOKEN_PATH } from "./auth.js";
import { accessToken } from "./auth.js";
import { main, REMOTE, VERSION } from "./index.js";

/**
 * Two modes, and the default is the one a client launches.
 *
 * With no argument this process is an MCP server speaking stdio, so nothing
 * may be written to stdout that is not a protocol message — every human-facing
 * line in this package goes to stderr for that reason.
 */

const [, , cmd] = process.argv;

async function run(): Promise<void> {
  switch (cmd) {
    case "login":
      await login();
      return;

    case "whoami": {
      const token = await accessToken();
      process.stderr.write(
        token
          ? `Signed in. Token from ${process.env.INITE_TOKEN ? "INITE_TOKEN" : TOKEN_PATH}.\n`
          : `Not signed in. Run \`npx @inite/mcp login\`.\n`,
      );
      process.exitCode = token ? 0 : 1;
      return;
    }

    case "--version":
    case "-v":
      process.stderr.write(`${VERSION}\n`);
      return;

    case "--help":
    case "-h":
      process.stderr.write(
        [
          `inite-mcp ${VERSION} — AI visibility audit as an MCP tool`,
          ``,
          `  inite-mcp            run as an MCP server over stdio (what a client does)`,
          `  inite-mcp login      sign in to inite.ai in your browser`,
          `  inite-mcp whoami     say whether a usable token is present`,
          ``,
          `  INITE_TOKEN      use this token instead of the stored one`,
          `  INITE_MCP_URL    point at a different endpoint (default ${REMOTE})`,
          ``,
        ].join("\n"),
      );
      return;

    default:
      if (cmd) {
        process.stderr.write(`Unknown command: ${cmd}. Try --help.\n`);
        process.exitCode = 2;
        return;
      }
      await main();
  }
}

run().catch((e: Error) => {
  process.stderr.write(`${e.message}\n`);
  process.exitCode = 1;
});
