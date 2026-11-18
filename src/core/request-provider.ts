import type { ProviderPreset, RequestProvider } from './request-command.js'
import { git, gitOutput } from '../git/client.js'
import { run } from '../runtime/runner.js'

/**
 * Resolves the configured provider to a command preset for the current `origin`.
 * `auto` detects the host and only picks a preset whose CLI is installed; `cnb-oauth` applies to CNB origins and
 * falls back to the same detection elsewhere.
 */
export async function resolveProviderPreset(provider: RequestProvider, context: any): Promise<ProviderPreset | null> {
  if (provider === 'none') {
    return null
  }

  if (provider === 'cnb-oauth') {
    // Classify with the URL the OAuth command itself reads: `git remote get-url` applies `insteadOf` rewrites,
    // while the raw `remote.origin.url` would hide a CNB alias such as `cnb:group/repo.git`.
    const origin = await gitOutput(['remote', 'get-url', 'origin'], context)
    if (origin && isCnbRemote(origin)) {
      return 'cnb-oauth'
    }
  }

  // OAuth creation only exists for CNB, so cnb-oauth falls back to auto detection elsewhere; this keeps a global
  // cnb-oauth setting usable in GitHub/GitLab repositories.
  if (provider === 'auto' || provider === 'cnb-oauth') {
    return detectProviderPreset(await readOriginUrl(context), context)
  }

  return provider
}

async function detectProviderPreset(origin: string | null, context: any): Promise<ProviderPreset | null> {
  if (!origin) {
    return null
  }

  if (isCnbRemote(origin) && (await hasGitSubcommand('cnb', context))) {
    return 'cnb'
  }

  if (isGitHubRemote(origin) && (await hasExecutable('gh', context))) {
    return 'github'
  }

  if (isGitLabRemote(origin) && (await hasExecutable('glab', context))) {
    return 'gitlab'
  }

  return null
}

async function hasGitSubcommand(command: string, context: any) {
  const result = await git([command, '-h'], context, { quiet: true, allowFailure: true })
  if (result.exitCode === 0) {
    return true
  }

  const output = result.all ?? ''
  return Boolean(output && !/not a git command|不是 git 命令|No manual entry/u.test(output))
}

async function readOriginUrl(context: any) {
  return (
    (await gitOutput(['config', '--get', 'remote.origin.url'], context)) ??
    (await gitOutput(['remote', 'get-url', 'origin'], context))
  )
}

async function hasExecutable(command: string, context: any) {
  const result = await run('sh', ['-c', `command -v ${command}`], {
    allowFailure: true,
    context,
    quiet: true,
  })
  return result.exitCode === 0
}

function isCnbRemote(origin: string) {
  return /(^|[/:@.])cnb\.cool([/:.]|$)/iu.test(origin)
}

function isGitHubRemote(origin: string) {
  return /(^|[/:@.])github\.com([/:.]|$)/iu.test(origin)
}

function isGitLabRemote(origin: string) {
  return /(^|[/:@.])gitlab\.com([/:.]|$)/iu.test(origin)
}
