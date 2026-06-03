import { useApp } from 'ink'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { getCurrentArgv } from '../cli/runtime-state.js'
import { createContext } from '../core/context.js'
import { CliError, compactOutput } from '../core/errors.js'
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
import { type ConfigSelection, assertConfigInteractiveTerminal, ConfigPicker } from '../ui/config.js'

export type ConfigCommandOptions = {
  color?: boolean
  detached?: boolean
  global?: boolean
  local?: boolean
  noColor?: boolean
  noDetached?: boolean
  quiet?: boolean
  show?: boolean
  spinner?: boolean
  strategy?: MrStrategy
  unset?: boolean
  verbose?: boolean
}

type Props = {
  options: ConfigCommandOptions
}

function colorOptionFromArgv(argv: string[]) {
  if (argv.includes('--color')) {
    return true
  }

  if (argv.includes('--no-color')) {
    return false
  }

  return undefined
}

function toCliError(error: any) {
  if (error instanceof CliError) {
    return error
  }

  return new CliError(error?.message ?? '未知错误。', { details: compactOutput(error?.stack) })
}

export function ConfigCommand({ options: commandOptions }: Props) {
  const { exit } = useApp()
  const argv = getCurrentArgv()
  const context = useMemo(
    () =>
      createContext({
        color: colorOptionFromArgv(argv),
        quiet: commandOptions.quiet,
        spinner: commandOptions.spinner,
        verbose: commandOptions.verbose,
      }),
    [argv, commandOptions],
  )
  const interactive =
    !commandOptions.show &&
    !commandOptions.strategy &&
    !commandOptions.unset &&
    !commandOptions.detached &&
    !commandOptions.noDetached
  const [settings, setSettings] = useState<MrSettings | null>(null)
  const [detachedSettings, setDetachedSettings] = useState<DetachedSettings | null>(null)
  const [selection, setSelection] = useState<ConfigSelection | null>(null)
  const [started, setStarted] = useState(false)
  const [saving, setSaving] = useState(false)

  const fail = useCallback(
    (error: unknown) => {
      const cliError = toCliError(error)
      context.ui.error(cliError)
      process.exitCode = cliError.exitCode || 1
      exit()
    },
    [context, exit],
  )

  const cancel = useCallback(() => {
    fail(new CliError('已取消设置。', { exitCode: 130 }))
  }, [fail])

  useEffect(() => {
    if (started) {
      return
    }

    setStarted(true)
    void runConfigAction(commandOptions, context, interactive, setSettings, setDetachedSettings)
      .then((completed) => {
        if (completed) {
          exit()
        }
      })
      .catch(fail)
  }, [commandOptions, context, exit, fail, interactive, started])

  useEffect(() => {
    if (!selection || saving) {
      return
    }

    setSaving(true)
    void saveConfig(selection, context)
      .then(() => exit())
      .catch(fail)
  }, [context, exit, fail, saving, selection])

  if (interactive && settings && detachedSettings && !saving) {
    return (
      <ConfigPicker
        ui={context.ui}
        settings={settings}
        detachedSettings={detachedSettings}
        onSelect={setSelection}
        onCancel={cancel}
      />
    )
  }

  return null
}

async function runConfigAction(
  options: ConfigCommandOptions,
  context: ReturnType<typeof createContext>,
  interactive: boolean,
  setSettings: (settings: MrSettings) => void,
  setDetachedSettings: (settings: DetachedSettings) => void,
) {
  assertValidOptions(options)

  if (options.show) {
    printSettings(await readMrSettings(context), await readDetachedSettings(context), context)
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
    printSettings(await readMrSettings(context), await readDetachedSettings(context), context)
    return true
  }

  if (options.strategy) {
    const scope = await resolveWriteScope(options, context)
    const detachedSettings = await readDetachedSettings(context)
    let detached = detachedSettings.effective
    if (options.detached) {
      detached = true
    }
    if (options.noDetached) {
      detached = false
    }
    await saveConfig({ scope, strategy: options.strategy, detached }, context)
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
    return false
  }

  return true
}

async function saveConfig(selection: ConfigSelection, context: ReturnType<typeof createContext>) {
  await writeStrategyConfig(selection.strategy, selection.scope, context)
  await writeDetachedConfig(selection.detached, selection.scope, context)
  context.ui.status('ok', `${scopeLabel(selection.scope)} mr.strategy=${selection.strategy}`)
  context.ui.status('info', strategyDescription(selection.strategy))
  context.ui.status('ok', `${scopeLabel(selection.scope)} mr.detached=${selection.detached ? 'true' : 'false'}`)
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

  if (options.unset && (options.strategy || options.detached || options.noDetached)) {
    throw new CliError('--unset 不能和修改配置的选项同时使用。')
  }

  if (options.detached && options.noDetached) {
    throw new CliError('--detached 不能和 --no-detached 同时使用。')
  }

  if (options.show && (options.unset || options.strategy || options.detached || options.noDetached)) {
    throw new CliError('--show 不能和修改配置的选项同时使用。')
  }
}

function printSettings(settings: MrSettings, detached: DetachedSettings, context: ReturnType<typeof createContext>) {
  context.ui.panel('mr 设置', [
    `当前有效策略: ${settings.effective} (${sourceText(settings.source)})`,
    `当前有效无感: ${detached.effective ? '开启' : '关闭'} (${detachedSourceText(detached.source)})`,
    `当前仓库策略: ${settings.local ?? (settings.localAvailable ? '未设置' : '不可用')}`,
    `当前仓库无感: ${detached.local === null ? (detached.localAvailable ? '未设置' : '不可用') : detached.local ? '开启' : '关闭'}`,
    `全局用户策略: ${settings.global ?? '未设置'}`,
    `全局用户无感: ${detached.global === null ? '未设置' : detached.global ? '开启' : '关闭'}`,
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
