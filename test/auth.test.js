import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdtemp, chmod, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Token precedence, and the permissions on the file that holds one.
 *
 * `INITE_TOKEN` has to win: it is how an MCP client config and CI both pass a
 * credential, and a stale file quietly beating the environment is the kind of
 * thing that costs an afternoon.
 */

const dir = await mkdtemp(join(tmpdir(), 'inite-mcp-'))
const file = join(dir, 'mcp.json')
process.env.INITE_TOKEN_FILE = file
const { accessToken } = await import('../dist/auth.js')

test('the environment beats the stored file', async () => {
  await writeFile(file, JSON.stringify({ access_token: 'from-file', client_id: 'c' }))
  process.env.INITE_TOKEN = 'from-env'
  assert.equal(await accessToken(), 'from-env')
  delete process.env.INITE_TOKEN
})

test('falls back to the stored file', async () => {
  await writeFile(file, JSON.stringify({ access_token: 'from-file', client_id: 'c' }))
  assert.equal(await accessToken(), 'from-file')
})

test('an empty environment variable does not shadow the file', async () => {
  process.env.INITE_TOKEN = '   '
  assert.equal(await accessToken(), 'from-file')
  delete process.env.INITE_TOKEN
})

test('no token anywhere is null, not a throw', async () => {
  process.env.INITE_TOKEN_FILE = join(dir, 'absent.json')
  const fresh = await import('../dist/auth.js?nocache=1')
  assert.equal(await fresh.accessToken(), null)
  process.env.INITE_TOKEN_FILE = file
})
