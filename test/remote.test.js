import { test } from 'node:test'
import assert from 'node:assert/strict'
import { remoteCall, NotSignedIn } from '../dist/index.js'

/**
 * The bridge does one thing — carry a call to inite.ai and bring the answer
 * back — so what is worth guarding is the handful of places it can lie about
 * what happened: dropping the credential, turning "signed out" into "broken",
 * or swallowing an error into a success.
 */

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('sends the token as a bearer', async () => {
  let seen
  await remoteCall('tools/list', undefined, 'tok-123', async (_u, init) => {
    seen = init
    return jsonRes({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
  })
  assert.equal(seen.headers.authorization, 'Bearer tok-123')
  assert.equal(JSON.parse(seen.body).method, 'tools/list')
})

test('turns 401 into a signed-out error the person can act on', async () => {
  await assert.rejects(
    () => remoteCall('tools/list', undefined, 'stale', async () => jsonRes({}, 401)),
    (e) => e instanceof NotSignedIn && /login/.test(e.message),
  )
})

test('surfaces a JSON-RPC error instead of returning undefined', async () => {
  await assert.rejects(
    () =>
      remoteCall('tools/call', {}, 'tok', async () =>
        jsonRes({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Unknown tool: nope' } }),
      ),
    /Unknown tool: nope/,
  )
})

test('reports a transport failure with its status', async () => {
  await assert.rejects(
    () => remoteCall('tools/list', undefined, 'tok', async () => jsonRes({}, 503)),
    /503/,
  )
})

test('returns the result untouched', async () => {
  const out = await remoteCall('tools/list', undefined, 'tok', async () =>
    jsonRes({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'analyze_site' }] } }),
  )
  assert.deepEqual(out, { tools: [{ name: 'analyze_site' }] })
})
