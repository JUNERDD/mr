import type { createContext } from '../core/context.js'
import { CliError } from '../core/errors.js'
import {
  type ConfigScope,
  type DetachedSettings,
  type MrSettings,
  type MrStrategy,
  isGitWorkTree,
  readDetachedSettings,
  readMrSettings,
  scopeLabel,
  strategyDescription,
  unsetDetachedConfig,
  unsetStrategyConfig,
  writeDetachedConfig,
  writeStrategyConfig,
} from '../core/settings.js'
import {
  type RequestCommandSettings,
  type RequestProvider,
  readRequestCommandSettings,
  unsetRequestCommandOnlyConfig,
  unsetRequestProviderConfig,
  writeRequestCommandConfig,
  writeRequestProviderConfig,
} from '../core/request-command.js'
import { type ConfigSelection, assertConfigInteractiveTerminal } from '../ui/config.js'
import { printSettings } from './config-output.js'
import { readWorktreeDirSettings } from './worktree-dir.js'

export type ConfigCommandOptions = {
  color?: boolean
  detached?: boolean
  global?: boolean
  local?: boolean
  noColor?: boolean
  noDetached?: boolean
  quiet?: boolean
  requestCommand?: string
  requestProvider?: RequestProvider
  show?: boolean
  spinner?: boolean
  strategy?: MrStrategy
  unset?: boolean
  unsetRequestCommand?: boolean
  unsetRequestProvider?: boolean
  verbose?: boolean
}

export async function runConfigAction(
  options: ConfigCommandOptions,
  context: ReturnType<typeof createContext>,
  interactive: boolean,
  setSettings: (settings: MrSettings) => void,
  setDetachedSettings: (settings: DetachedSettings) => void,
  setRequestCommandSettings: (settings: RequestCommandSettings) => void,
) {
  assertValidOptions(options)

  if (options.show) {
    printSettings(
      await readMrSettings(context),
      await readDetachedSettings(context),
      await readRequestCommandSettings(context),
      await readWorktreeDirSettings(context),
      context,
    )
    return true
  }

  if (options.unset) {
    const scope = await resolveWriteScope(options, context)
    const strategyChanged = await unsetStrategyConfig(scope, context)
    const detachedChanged = await unsetDetachedConfig(scope, context)
    context.ui.status(
      strategyChanged ? 'ok' : 'skip',
      `${scopeLabel(scope)} mr.strategy ${strategyChanged ? '已清除' : '未设置'}`,
    )
    context.ui.status(
      detachedChanged ? 'ok' : 'skip',
      `${scopeLabel(scope)} mr.detached ${detachedChanged ? '已清除' : '未设置'}`,
    )
    printSettings(
      await readMrSettings(context),
      await readDetachedSettings(context),
      await readRequestCommandSettings(context),
      await readWorktreeDirSettings(context),
      context,
    )
    return true
  }

  if (options.unsetRequestCommand || options.unsetRequestProvider) {
    await unsetRequestConfig(options, context)
    return true
  }

  if (options.strategy || options.requestProvider || options.requestCommand) {
    await writeExplicitConfig(options, context)
    return true
  }

  if (options.detached || options.noDetached) {
    const scope = await resolveWriteScope(options, context)
    const settings = await readMrSettings(context)
    await saveConfig(
      {
        scope,
        strategy: settings.effective,
        detached: options.detached ? true : false,
      },
      context,
    )
    return true
  }

  if (interactive) {
    assertConfigInteractiveTerminal(process.stdin, process.stderr)
    setSettings(await readMrSettings(context))
    setDetachedSettings(await readDetachedSettings(context))
    setRequestCommandSettings(await readRequestCommandSettings(context))
    return false
  }

  return true
}

async function unsetRequestConfig(options: ConfigCommandOptions, context: ReturnType<typeof createContext>) {
  const scope = await resolveWriteScope(options, context)
  if (options.unsetRequestCommand) {
    const changed = await unsetRequestCommandOnlyConfig(scope, context)
    context.ui.status(
      changed ? 'ok' : 'skip',
      `${scopeLabel(scope)} mr.requestCommand ${changed ? '已清除' : '未设置'}`,
    )
  }
  if (options.unsetRequestProvider) {
    const changed = await unsetRequestProviderConfig(scope, context)
    context.ui.status(
      changed ? 'ok' : 'skip',
      `${scopeLabel(scope)} mr.requestProvider ${changed ? '已清除' : '未设置'}`,
    )
  }
  printSettings(
    await readMrSettings(context),
    await readDetachedSettings(context),
    await readRequestCommandSettings(context),
    await readWorktreeDirSettings(context),
    context,
  )
}

async function writeExplicitConfig(options: ConfigCommandOptions, context: ReturnType<typeof createContext>) {
  const scope = await resolveWriteScope(options, context)

  if (options.strategy || options.detached || options.noDetached) {
    const settings = await readMrSettings(context)
    const detachedSettings = await readDetachedSettings(context)
    const strategy = options.strategy ?? settings.effective
    let detached = detachedSettings.effective
    if (options.detached) {
      detached = true
    }
    if (options.noDetached) {
      detached = false
    }
    await saveConfig({ scope, strategy, detached }, context)
  }

  if (options.requestProvider) {
    await writeRequestProviderConfig(options.requestProvider, scope, context)
    context.ui.status('ok', `${scopeLabel(scope)} mr.requestProvider=${options.requestProvider}`)
  }
  if (options.requestCommand) {
    await writeRequestCommandConfig(options.requestCommand.trim(), scope, context)
    context.ui.status('ok', `${scopeLabel(scope)} mr.requestCommand 已设置`)
  }
}

type SavedConfigSelection =
  | ConfigSelection
  | { detached: boolean; provider?: RequestProvider; scope: ConfigScope; strategy: MrStrategy }

export async function saveConfig(selection: SavedConfigSelection, context: ReturnType<typeof createContext>) {
  await writeStrategyConfig(selection.strategy, selection.scope, context)
  await writeDetachedConfig(selection.detached, selection.scope, context)
  context.ui.status('ok', `${scopeLabel(selection.scope)} mr.strategy=${selection.strategy}`)
  context.ui.status('info', strategyDescription(selection.strategy))
  context.ui.status('ok', `${scopeLabel(selection.scope)} mr.detached=${selection.detached ? 'true' : 'false'}`)
  if (selection.provider) {
    await writeRequestProviderConfig(selection.provider, selection.scope, context)
    context.ui.status('ok', `${scopeLabel(selection.scope)} mr.requestProvider=${selection.provider}`)
  }
}

async function resolveWriteScope(
  options: ConfigCommandOptions,
  context: ReturnType<typeof createContext>,
): Promise<ConfigScope> {
  if (options.global) {
    return 'global'
  }

  if (options.local) {
    return 'local'
  }

  return (await isGitWorkTree(context)) ? 'local' : 'global'
}

function assertValidOptions(options: ConfigCommandOptions) {
  if (options.global && options.local) {
    throw new CliError('只能指定一个配置作用域。', {
      next: ['使用 --local 写入当前仓库，或使用 --global 写入全局用户配置。'],
    })
  }

  if (
    options.unset &&
    (options.strategy ||
      options.detached ||
      options.noDetached ||
      options.requestCommand ||
      options.requestProvider ||
      options.unsetRequestCommand ||
      options.unsetRequestProvider)
  ) {
    throw new CliError('--unset 不能和修改配置的选项同时使用。')
  }

  if (
    (options.unsetRequestCommand || options.unsetRequestProvider) &&
    (options.strategy || options.detached || options.noDetached || options.requestCommand || options.requestProvider)
  ) {
    throw new CliError('清除请求配置的选项不能和修改配置的选项同时使用。')
  }

  if (options.requestCommand !== undefined && !options.requestCommand.trim()) {
    throw new CliError('--request-command 不能为空。')
  }

  if (options.detached && options.noDetached) {
    throw new CliError('--detached 不能和 --no-detached 同时使用。')
  }

  if (
    options.show &&
    (options.unset ||
      options.strategy ||
      options.detached ||
      options.noDetached ||
      options.requestCommand ||
      options.requestProvider ||
      options.unsetRequestCommand ||
      options.unsetRequestProvider)
  ) {
    throw new CliError('--show 不能和修改配置的选项同时使用。')
  }
}
