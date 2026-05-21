import { CliError } from './errors.js'
import { git, gitOutput } from '../git/client.js'

export const MR_STRATEGY_VALUES = ['pr', 'merge', 'rebase', 'merge-target'] as const

export type ConfigScope = 'local' | 'global'
export type MrStrategy = (typeof MR_STRATEGY_VALUES)[number]
export type MrStrategySource = 'environment' | 'local' | 'global' | 'legacy' | 'builtin'

export type MrSettings = {
  effective: MrStrategy
  global: MrStrategy | null
  local: MrStrategy | null
  localAvailable: boolean
  source: MrStrategySource
}

export const MR_STRATEGY_CHOICES: Array<{ description: string; label: string; value: MrStrategy }> = [
  {
    value: 'merge',
    label: 'merge',
    description: '默认策略：从目标分支准备 MR 分支，再 merge 当前分支',
  },
  {
    value: 'rebase',
    label: 'rebase',
    description: '从当前分支准备 MR 分支，再 rebase 到目标分支',
  },
  {
    value: 'merge-target',
    label: 'merge-target',
    description: '从当前分支准备 MR 分支，再 merge 目标分支',
  },
  {
    value: 'pr',
    label: 'pr',
    description: '直接用当前分支创建 PR，不创建 MR 分支',
  },
]

export function normalizeMrStrategy(value: string): MrStrategy {
  const normalized = value.trim().toLowerCase().replace(/_/gu, '-')
  if (MR_STRATEGY_VALUES.includes(normalized as MrStrategy)) {
    return normalized as MrStrategy
  }

  throw new CliError(`不支持的 MR 策略: ${value}`, {
    next: ['可选值: pr, merge, rebase, merge-target', '运行 mr --config 进入交互式设置。'],
  })
}

export function scopeLabel(scope: ConfigScope) {
  return scope === 'global' ? '全局用户' : '当前仓库'
}

export function strategyDescription(strategy: MrStrategy) {
  return MR_STRATEGY_CHOICES.find((choice) => choice.value === strategy)?.description ?? strategy
}

export async function isGitWorkTree(context: any) {
  return (await gitOutput(['rev-parse', '--is-inside-work-tree'], context)) === 'true'
}

export async function readMrSettings(context: any): Promise<MrSettings> {
  const envStrategy = readEnvStrategy(context)
  const localAvailable = await isGitWorkTree(context)
  const local = localAvailable ? await readScopeStrategy('local', context) : null
  const global = await readScopeStrategy('global', context)
  const legacy = await readLegacyRebaseStrategy(context)

  if (envStrategy) {
    return { effective: envStrategy, global, local, localAvailable, source: 'environment' }
  }

  if (local) {
    return { effective: local, global, local, localAvailable, source: 'local' }
  }

  if (global) {
    return { effective: global, global, local, localAvailable, source: 'global' }
  }

  if (legacy) {
    return { effective: legacy, global, local, localAvailable, source: 'legacy' }
  }

  return { effective: 'merge', global, local, localAvailable, source: 'builtin' }
}

export async function writeStrategyConfig(strategy: MrStrategy, scope: ConfigScope, context: any) {
  await assertScopeWritable(scope, context)
  await git(['config', scopeArg(scope), 'mr.strategy', strategy], context, {
    label: `写入 ${scopeLabel(scope)} 配置`,
    mutates: true,
    quiet: true,
  })
}

export async function unsetStrategyConfig(scope: ConfigScope, context: any) {
  await assertScopeWritable(scope, context)
  const current = await readScopeStrategy(scope, context)
  if (!current) {
    return false
  }

  await git(['config', scopeArg(scope), '--unset', 'mr.strategy'], context, {
    label: `清除 ${scopeLabel(scope)} 配置`,
    mutates: true,
    quiet: true,
  })
  return true
}

async function assertScopeWritable(scope: ConfigScope, context: any) {
  if (scope === 'local' && !(await isGitWorkTree(context))) {
    throw new CliError('当前目录不是 Git 仓库，无法写入当前仓库配置。', {
      next: ['进入 Git 仓库后重试，或使用 mr --config --global --strategy merge。'],
    })
  }
}

function readEnvStrategy(context: any) {
  const value = context.env?.MR_STRATEGY
  return value && value.trim() ? normalizeMrStrategy(value) : null
}

async function readScopeStrategy(scope: ConfigScope, context: any) {
  const value = await gitOutput(['config', scopeArg(scope), '--get', 'mr.strategy'], context)
  return value ? normalizeMrStrategy(value) : null
}

async function readLegacyRebaseStrategy(context: any): Promise<MrStrategy | null> {
  const value = await gitOutput(['config', '--bool', '--get', 'mr.rebase'], context)
  if (value === 'true') {
    return 'rebase'
  }

  if (value === 'false') {
    return 'merge'
  }

  return null
}

function scopeArg(scope: ConfigScope) {
  return scope === 'global' ? '--global' : '--local'
}
