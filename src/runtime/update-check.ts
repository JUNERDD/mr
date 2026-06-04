import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

type UpdateCache = {
  checkedAt?: number
  latestUrl?: string
  latestVersion?: string
  notifiedAt?: number
  notifiedVersion?: string
}

type LatestRelease = {
  url?: string
  version: string
}

type FetchLike = typeof fetch

export type UpdateNotification = {
  currentVersion: string
  latestUrl?: string
  latestVersion: string
}

type CheckForUpdateOptions = {
  argv?: string[]
  cachePath?: string
  checkIntervalMs?: number
  currentVersion: string
  env?: NodeJS.ProcessEnv
  fetchImpl?: FetchLike
  now?: number
  notifyIntervalMs?: number
  stream?: { isTTY?: boolean }
  timeoutMs?: number
}

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const GITHUB_LATEST_RELEASE_URL = 'https://api.github.com/repos/JUNERDD/mr/releases/latest'

function isDisabled(value: string | undefined) {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false'
}

function parseVersion(version: string) {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u)
  if (!match) {
    return null
  }

  return match.slice(1).map(Number) as [number, number, number]
}

export function compareVersions(a: string, b: string) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) {
    return 0
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] > right[index] ? 1 : -1
    }
  }

  return 0
}

function cachePath(env: NodeJS.ProcessEnv) {
  if (env.MR_UPDATE_CHECK_CACHE) {
    return env.MR_UPDATE_CHECK_CACHE
  }

  const base = env.XDG_CACHE_HOME || (env.HOME ? join(env.HOME, '.cache') : join(homedir() || tmpdir(), '.cache'))
  return join(base, 'mr', 'update-check.json')
}

function shouldSkipArgv(argv: string[]) {
  const skipped = new Set(['--help', '-h', '-help', '--version', '-v', '--update', '--uninstall', '--quiet'])
  return argv.some((arg) => skipped.has(arg))
}

export function shouldSkipUpdateCheck({
  argv = process.argv,
  currentVersion,
  env = process.env,
  stream = process.stderr,
}: Pick<CheckForUpdateOptions, 'argv' | 'currentVersion' | 'env' | 'stream'>) {
  return (
    !stream.isTTY ||
    shouldSkipArgv(argv) ||
    isDisabled(env.CI) ||
    env.NODE_ENV === 'test' ||
    isDisabled(env.VITEST) ||
    isDisabled(env.MR_NO_UPDATE_CHECK) ||
    isDisabled(env.NO_UPDATE_NOTIFIER) ||
    parseVersion(currentVersion) === null ||
    currentVersion.includes('-dev')
  )
}

async function readCache(path: string): Promise<UpdateCache> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as UpdateCache
  } catch {
    return {}
  }
}

async function writeCache(path: string, cache: UpdateCache) {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(cache)}\n`)
  } catch {
    // Update checks must never make the CLI command fail.
  }
}

async function fetchLatestRelease(fetchImpl: FetchLike, timeoutMs: number): Promise<LatestRelease | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(GITHUB_LATEST_RELEASE_URL, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'mr-cli-update-check',
        'x-github-api-version': '2022-11-28',
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      return null
    }

    const json = (await response.json()) as { html_url?: unknown; tag_name?: unknown }
    if (typeof json.tag_name !== 'string') {
      return null
    }

    return {
      url: typeof json.html_url === 'string' ? json.html_url : undefined,
      version: json.tag_name,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function shouldNotify(
  cache: UpdateCache,
  currentVersion: string,
  latestVersion: string,
  now: number,
  intervalMs: number,
) {
  return (
    compareVersions(latestVersion, currentVersion) > 0 &&
    (cache.notifiedVersion !== latestVersion || !cache.notifiedAt || now - cache.notifiedAt >= intervalMs)
  )
}

export async function checkForUpdate({
  argv = process.argv,
  cachePath: cachePathOverride,
  checkIntervalMs = CHECK_INTERVAL_MS,
  currentVersion,
  env = process.env,
  fetchImpl = fetch,
  now = Date.now(),
  notifyIntervalMs = CHECK_INTERVAL_MS,
  stream = process.stderr,
  timeoutMs = 1200,
}: CheckForUpdateOptions): Promise<UpdateNotification | null> {
  if (shouldSkipUpdateCheck({ argv, currentVersion, env, stream })) {
    return null
  }

  const path = cachePathOverride ?? cachePath(env)
  let cache = await readCache(path)
  const stale = !cache.checkedAt || now - cache.checkedAt >= checkIntervalMs

  if (stale) {
    const latest = await fetchLatestRelease(fetchImpl, timeoutMs)
    cache = {
      ...cache,
      checkedAt: now,
      latestUrl: latest?.url ?? cache.latestUrl,
      latestVersion: latest?.version ?? cache.latestVersion,
    }
    await writeCache(path, cache)
  }

  const latestVersion = cache.latestVersion
  if (!latestVersion || !shouldNotify(cache, currentVersion, latestVersion, now, notifyIntervalMs)) {
    return null
  }

  cache = { ...cache, notifiedAt: now, notifiedVersion: latestVersion }
  await writeCache(path, cache)

  return {
    currentVersion,
    latestUrl: cache.latestUrl,
    latestVersion,
  }
}
