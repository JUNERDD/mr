import type { createContext } from '../core/context.js'
import type { RequestCommandSettings } from '../core/request-command.js'
import { type DetachedSettings, type MrSettings, scopeLabel } from '../core/settings.js'

export function printSettings(
  settings: MrSettings,
  detached: DetachedSettings,
  requestCommand: RequestCommandSettings,
  context: ReturnType<typeof createContext>,
) {
  context.ui.panel('mr 设置', [
    `当前有效策略: ${settings.effective} (${sourceText(settings.source)})`,
    `当前有效无感: ${detached.effective ? '开启' : '关闭'} (${detachedSourceText(detached.source)})`,
    `请求 provider: ${requestCommand.provider} (${providerSourceText(requestCommand.providerSource)})`,
    `合并请求命令: ${requestCommand.effective ? `${requestCommand.effective} (${requestCommandSourceText(requestCommand.source)})` : '未配置（只推送分支）'}`,
    `当前仓库策略: ${settings.local ?? (settings.localAvailable ? '未设置' : '不可用')}`,
    `当前仓库无感: ${detached.local === null ? (detached.localAvailable ? '未设置' : '不可用') : detached.local ? '开启' : '关闭'}`,
    `当前仓库 provider: ${requestCommand.providerLocal ?? (requestCommand.localAvailable ? '未设置' : '不可用')}`,
    `当前仓库命令: ${requestCommand.local ?? (requestCommand.localAvailable ? '未设置' : '不可用')}`,
    `全局用户策略: ${settings.global ?? '未设置'}`,
    `全局用户无感: ${detached.global === null ? '未设置' : detached.global ? '开启' : '关闭'}`,
    `全局用户 provider: ${requestCommand.providerGlobal ?? '未设置'}`,
    `全局用户命令: ${requestCommand.global ?? '未设置'}`,
  ])
}

function detachedSourceText(source: DetachedSettings['source']) {
  if (source === 'environment') {
    return 'MR_DETACHED 环境变量'
  }

  if (source === 'local' || source === 'global') {
    return `${scopeLabel(source)} 配置`
  }

  return '内置默认'
}

function sourceText(source: MrSettings['source']) {
  if (source === 'environment') {
    return 'MR_STRATEGY 环境变量'
  }

  if (source === 'local' || source === 'global') {
    return `${scopeLabel(source)}配置`
  }

  if (source === 'legacy') {
    return '兼容 mr.rebase 配置'
  }

  return '内置默认'
}

function requestCommandSourceText(source: RequestCommandSettings['source']) {
  if (source === 'environment') {
    return 'MR_REQUEST_COMMAND 环境变量'
  }

  if (source === 'local' || source === 'global') {
    return `${scopeLabel(source)}配置`
  }

  if (source === 'auto') {
    return 'provider 预设'
  }

  return '未配置'
}

function providerSourceText(source: RequestCommandSettings['providerSource']) {
  if (source === 'environment') {
    return 'MR_REQUEST_PROVIDER 环境变量'
  }

  if (source === 'local' || source === 'global') {
    return `${scopeLabel(source)}配置`
  }

  return '内置默认'
}
