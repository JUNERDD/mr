import { CliError } from '../core/errors.js'
import type { RequestCommandSettings, RequestProvider } from '../core/request-command.js'
import {
  type ConfigScope,
  type DetachedSettings,
  MR_STRATEGY_CHOICES,
  type MrSettings,
  scopeLabel,
} from '../core/settings.js'

export const DETACHED_CHOICES = [
  { value: false, label: '关闭', description: '默认切换本地 MR 分支（内联模式）' },
  { value: true, label: '开启', description: '无感模式：不切本地分支，冲突时使用临时 worktree' },
] as const

const PROVIDER_CHOICES: Array<{ description: string; label: string; value: RequestProvider }> = [
  { value: 'auto', label: 'auto', description: '按 origin 自动识别 CNB / GitHub / GitLab' },
  { value: 'none', label: 'none', description: '只推送分支，手动创建合并请求' },
  { value: 'cnb', label: 'cnb', description: '使用 git cnb pull create' },
  { value: 'github', label: 'github', description: '使用 gh pr create' },
  { value: 'gitlab', label: 'gitlab', description: '使用 glab mr create' },
]

export function createConfigScopeChoices(localAvailable: boolean) {
  const choices: Array<{ description: string; label: string; value: ConfigScope }> = []

  if (localAvailable) {
    choices.push({
      value: 'local',
      label: '当前仓库',
      description: '写入 .git/config，只影响当前项目',
    })
  }

  choices.push({
    value: 'global',
    label: '全局用户',
    description: '写入用户 Git config，作为所有项目的默认值',
  })

  return choices
}

export function createStrategyChoices() {
  return MR_STRATEGY_CHOICES
}

export function createProviderChoices() {
  return PROVIDER_CHOICES
}

export function assertConfigInteractiveTerminal(
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream & { isTTY?: boolean } = process.stderr,
) {
  if (!input.isTTY || !output.isTTY) {
    throw new CliError('mr --config 需要在交互式终端中设置默认值。', {
      next: ['在脚本或 CI 中请使用: mr --config --strategy rebase 或 mr --config --request-provider github'],
    })
  }
}

export function providerSourceText(source: RequestCommandSettings['providerSource']) {
  if (source === 'environment') {
    return 'MR_REQUEST_PROVIDER 环境变量'
  }

  if (source === 'local' || source === 'global') {
    return `${scopeLabel(source)} 配置`
  }

  return '内置默认'
}

export function detachedSourceText(source: DetachedSettings['source']) {
  if (source === 'environment') {
    return 'MR_DETACHED 环境变量'
  }

  if (source === 'local' || source === 'global') {
    return `${scopeLabel(source)} 配置`
  }

  return '内置默认'
}

export function sourceText(source: MrSettings['source']) {
  if (source === 'environment') {
    return 'MR_STRATEGY 环境变量'
  }

  if (source === 'local' || source === 'global') {
    return `${scopeLabel(source)} 配置`
  }

  if (source === 'legacy') {
    return '兼容 mr.rebase 配置'
  }

  return '内置默认'
}
