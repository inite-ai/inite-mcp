import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/**
 * `npx @inite/visibility` has to keep working, and what makes it work is a
 * detail worth writing down before somebody trips over it.
 *
 * npm resolves the command from the package name with the scope stripped —
 * `visibility` — and this package's binary is called `inite-visibility`. That
 * mismatch is survivable only because there is exactly one binary: with one,
 * npm runs it regardless of the name; with two, it cannot choose and refuses.
 *
 * So a second `bin` entry breaks the documented install line for every client,
 * silently, and nowhere near the change that caused it.
 *
 * The obvious escape — naming the binary `visibility` to match — is worse. A
 * scoped package has no business claiming a word that general in someone's
 * PATH on a global install.
 */
test('ships exactly one binary, or npx cannot pick', () => {
  const bins = Object.keys(pkg.bin ?? {})
  assert.deepEqual(bins, ['inite-visibility'])
})

test('the install line in the README is the one that resolves', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(readme, /npx["\s,\]]+.*@inite\/visibility/s)
  assert.doesNotMatch(readme, /@inite\/mcp/, 'the old name would 404 on npm')
})

test('the package name and the MCP server name agree', () => {
  // server.json is what the registry publishes and the catalogues mirror; a
  // package identifier that disagrees with it sends people to nothing.
  const server = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'))
  assert.equal(server.packages[0].identifier, pkg.name)
  assert.equal(server.packages[0].version, pkg.version)
})
