import { CliError } from './errors.js'
import { type ConfigScope, isGitWorkTree, scopeLabel } from './settings.js'
import { git, gitOutput } from '../git/client.js'
import { run } from '../runtime/runner.js'

export const REQUEST_PROVIDER_VALUES = ['auto', 'none', 'cnb', 'github', 'gitlab'] as const

export type RequestProvider = (typeof REQUEST_PROVIDER_VALUES)[number]
export type RequestProviderSource = 'environment' | 'local' | 'global' | 'builtin'
export type RequestCommandSource = 'environment' | 'local' | 'global' | 'auto' | 'builtin'

type ProviderPreset = Exclude<RequestProvider, 'auto' | 'none'>

export type RequestCommandSettings = {
  effective: string | null
  global: string | null
  local: string | null
  localAvailable: boolean
  provider: RequestProvider
  providerGlobal: RequestProvider | null
  providerLocal: RequestProvider | null
  providerSource: RequestProviderSource
  source: RequestCommandSource
}

const PROVIDER_COMMANDS: Record<ProviderPreset, string> = {
  cnb: 'git cnb pull create -H "$MR_SOURCE_BRANCH" -B "$MR_TARGET_BRANCH"',
  github: 'gh pr create --fill --head "$MR_SOURCE_BRANCH" --base "$MR_TARGET_BRANCH"',
  gitlab: 'glab mr create --fill --source-branch "$MR_SOURCE_BRANCH" --target-branch "$MR_TARGET_BRANCH"',
}

export async function readRequestCommandSettings(context: any): Promise<RequestCommandSettings> {
  const envCommand = readEnvRequestCommand(context)
  const localAvailable = await isGitWorkTree(context)
  const local = localAvailable ? await readScopeRequestCommand('local', context) : null
  const global = await readScopeRequestCommand('global', context)

  if (envCommand) {
    const providerSettings = await readRequestProviderSettingsSafely(context, localAvailable)
    return {
      ...requestCommandBase(global, local, localAvailable, providerSettings),
      effective: envCommand,
      source: 'environment',
    }
  }

  if (local) {
    const providerSettings = await readRequestProviderSettingsSafely(context, localAvailable)
    return {
      ...requestCommandBase(global, local, localAvailable, providerSettings),
      effective: local,
      source: 'local',
    }
  }

  if (global) {
    const providerSettings = await readRequestProviderSettingsSafely(context, localAvailable)
    return {
      ...requestCommandBase(global, local, localAvailable, providerSettings),
      effective: global,
      source: 'global',
    }
  }

  const providerSettings = await readRequestProviderSettings(context, localAvailable)
  const base = {
    global,
    local,
    localAvailable,
    provider: providerSettings.effective,
    providerGlobal: providerSettings.global,
    providerLocal: providerSettings.local,
    providerSource: providerSettings.source,
  }

  const preset = await resolveProviderPreset(providerSettings.effective, context)
  if (preset) {
    return { ...base, effective: PROVIDER_COMMANDS[preset], provider: preset, source: 'auto' }
  }

  return { ...base, effective: null, source: 'builtin' }
}

function requestCommandBase(
  global: string | null,
  local: string | null,
  localAvailable: boolean,
  providerSettings: Awaited<ReturnType<typeof readRequestProviderSettings>>,
) {
  return {
    global,
    local,
    localAvailable,
    provider: providerSettings.effective,
    providerGlobal: providerSettings.global,
    providerLocal: providerSettings.local,
    providerSource: providerSettings.source,
  }
}

export async function writeRequestProviderConfig(provider: RequestProvider, scope: ConfigScope, context: any) {
  await assertScopeWritable(scope, context)
  await git(['config', scopeArg(scope), 'mr.requestProvider', provider], context, {
    label: `写入 ${scopeLabel(scope)} 请求 provider 配置`,
    mutates: true,
    quiet: true,
  })
}

export async function writeRequestCommandConfig(command: string, scope: ConfigScope, context: any) {
  await assertScopeWritable(scope, context)
  await git(['config', scopeArg(scope), 'mr.requestCommand', command], context, {
    label: `写入 ${scopeLabel(scope)} 请求命令配置`,
    mutates: true,
    quiet: true,
  })
}

export async function unsetRequestCommandOnlyConfig(scope: ConfigScope, context: any) {
  await assertScopeWritable(scope, context)
  const current = await readScopeRequestCommand(scope, context)
  if (!current) {
    return false
  }

  await git(['config', scopeArg(scope), '--unset', 'mr.requestCommand'], context, {
    label: `清除 ${scopeLabel(scope)} 请求命令配置`,
    mutates: true,
    quiet: true,
  })
  return true
}

export async function unsetRequestProviderConfig(scope: ConfigScope, context: any) {
  await assertScopeWritable(scope, context)
  const current = await readScopeRequestProvider(scope, context)
  if (!current) {
    return false
  }

  await git(['config', scopeArg(scope), '--unset', 'mr.requestProvider'], context, {
    label: `清除 ${scopeLabel(scope)} 请求 provider 配置`,
    mutates: true,
    quiet: true,
  })
  return true
}

export function normalizeRequestProvider(value: string): RequestProvider {
  const normalized = value.trim().toLowerCase()
  if (REQUEST_PROVIDER_VALUES.includes(normalized as RequestProvider)) {
    return normalized as RequestProvider
  }

  throw new CliError(`不支持的请求 provider: ${value}`, {
    next: ['可选值: auto, none, cnb, github, gitlab'],
  })
}

async function assertScopeWritable(scope: ConfigScope, context: any) {
  if (scope === 'local' && !(await isGitWorkTree(context))) {
    throw new CliError('当前目录不是 Git 仓库，无法写入当前仓库配置。', {
      next: ['进入 Git 仓库后重试，或使用 mr --config --global --strategy merge。'],
    })
  }
}

function readEnvRequestCommand(context: any) {
  const value = context.env?.MR_REQUEST_COMMAND
  return value && value.trim() ? value.trim() : null
}

function readEnvRequestProvider(context: any) {
  const value = context.env?.MR_REQUEST_PROVIDER
  return value && value.trim() ? normalizeRequestProvider(value) : null
}

async function readScopeRequestCommand(scope: ConfigScope, context: any) {
  const value = await gitOutput(['config', scopeArg(scope), '--get', 'mr.requestCommand'], context)
  return value && value.trim() ? value.trim() : null
}

async function readScopeRequestProvider(scope: ConfigScope, context: any) {
  const value = await gitOutput(['config', scopeArg(scope), '--get', 'mr.requestProvider'], context)
  return value && value.trim() ? normalizeRequestProvider(value) : null
}

async function readRequestProviderSettings(context: any, localAvailable: boolean) {
  const envProvider = readEnvRequestProvider(context)
  const local = localAvailable ? await readScopeRequestProvider('local', context) : null
  const global = await readScopeRequestProvider('global', context)

  if (envProvider) {
    return { effective: envProvider, global, local, source: 'environment' as const }
  }

  if (local) {
    return { effective: local, global, local, source: 'local' as const }
  }

  if (global) {
    return { effective: global, global, local, source: 'global' as const }
  }

  return { effective: 'auto' as const, global, local, source: 'builtin' as const }
}

async function readRequestProviderSettingsSafely(context: any, localAvailable: boolean) {
  try {
    return await readRequestProviderSettings(context, localAvailable)
  } catch {
    return { effective: 'auto' as const, global: null, local: null, source: 'builtin' as const }
  }
}

async function resolveProviderPreset(provider: RequestProvider, context: any): Promise<ProviderPreset | null> {
  if (provider === 'none') {
    return null
  }

  if (provider !== 'auto') {
    return provider
  }

  const origin = await readOriginUrl(context)
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

function scopeArg(scope: ConfigScope) {
  return scope === 'global' ? '--global' : '--local'
}
