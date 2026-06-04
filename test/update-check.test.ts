import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'vitest'
import { checkForUpdate, compareVersions, shouldSkipUpdateCheck } from '../src/runtime/update-check.js'

function responseWith(json: unknown, ok = true) {
  return {
    ok,
    json: async () => json,
  } as Response
}

test('compareVersions handles release tags with a leading v', () => {
  assert.equal(compareVersions('v0.6.7', '0.6.6'), 1)
  assert.equal(compareVersions('0.6.6', 'v0.6.6'), 0)
  assert.equal(compareVersions('0.6.5', '0.6.6'), -1)
  assert.equal(compareVersions('dev', '0.6.6'), 0)
})

test('shouldSkipUpdateCheck avoids noisy environments', () => {
  const base = {
    argv: ['node', 'mr', 'test'],
    currentVersion: '0.6.6',
    env: {},
    stream: { isTTY: true },
  }

  assert.equal(shouldSkipUpdateCheck(base), false)
  assert.equal(shouldSkipUpdateCheck({ ...base, stream: { isTTY: false } }), true)
  assert.equal(shouldSkipUpdateCheck({ ...base, argv: ['node', 'mr', '--quiet', 'test'] }), true)
  assert.equal(shouldSkipUpdateCheck({ ...base, argv: ['node', 'mr', '--update'] }), true)
  assert.equal(shouldSkipUpdateCheck({ ...base, env: { CI: 'true' } }), true)
  assert.equal(shouldSkipUpdateCheck({ ...base, env: { MR_NO_UPDATE_CHECK: '1' } }), true)
  assert.equal(shouldSkipUpdateCheck({ ...base, env: { NO_UPDATE_NOTIFIER: '1' } }), true)
  assert.equal(shouldSkipUpdateCheck({ ...base, currentVersion: '0.0.0-dev' }), true)
})

test('checkForUpdate fetches latest release, caches it, and throttles repeated prompts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-update-check-'))
  const cachePath = join(root, 'update-check.json')
  let calls = 0
  const fetchImpl = (async () => {
    calls += 1
    return responseWith({
      html_url: 'https://github.com/JUNERDD/mr/releases/tag/v0.6.7',
      tag_name: 'v0.6.7',
    })
  }) as typeof fetch

  try {
    const first = await checkForUpdate({
      argv: ['node', 'mr', 'test'],
      cachePath,
      currentVersion: '0.6.6',
      env: {},
      fetchImpl,
      now: 1000,
      stream: { isTTY: true },
    })

    assert.deepEqual(first, {
      currentVersion: '0.6.6',
      latestUrl: 'https://github.com/JUNERDD/mr/releases/tag/v0.6.7',
      latestVersion: 'v0.6.7',
    })

    const second = await checkForUpdate({
      argv: ['node', 'mr', 'test'],
      cachePath,
      currentVersion: '0.6.6',
      env: {},
      fetchImpl,
      now: 2000,
      stream: { isTTY: true },
    })

    assert.equal(second, null)
    assert.equal(calls, 1)

    const cache = JSON.parse(await readFile(cachePath, 'utf8'))
    assert.equal(cache.checkedAt, 1000)
    assert.equal(cache.notifiedAt, 1000)
    assert.equal(cache.notifiedVersion, 'v0.6.7')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('checkForUpdate refreshes stale cache without failing on network errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-update-check-stale-'))
  const cachePath = join(root, 'nested/update-check.json')
  const fetchImpl = (async () => {
    throw new Error('offline')
  }) as typeof fetch

  try {
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(
      cachePath,
      JSON.stringify({
        checkedAt: 1,
        latestVersion: 'v0.6.7',
        notifiedAt: 1,
        notifiedVersion: 'v0.6.7',
      }),
    )

    const result = await checkForUpdate({
      argv: ['node', 'mr', 'test'],
      cachePath,
      checkIntervalMs: 10,
      currentVersion: '0.6.6',
      env: {},
      fetchImpl,
      now: 1000,
      notifyIntervalMs: 10,
      stream: { isTTY: true },
    })

    assert.equal(result?.latestVersion, 'v0.6.7')
    const cache = JSON.parse(await readFile(cachePath, 'utf8'))
    assert.equal(cache.checkedAt, 1000)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
