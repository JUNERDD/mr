import { useApp } from 'ink'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { getCurrentArgv } from '../cli/runtime-state.js'
import { createContext } from '../core/context.js'
import { CliError, compactOutput } from '../core/errors.js'
import {
  type ConfigScope,
  type MrSettings,
  type MrStrategy,
  isGitWorkTree,
  readMrSettings,
  scopeLabel,
  strategyDescription,
  unsetStrategyConfig,
  writeStrategyConfig,
} from '../core/settings.js'
import { type ConfigSelection, assertConfigInteractiveTerminal, ConfigPicker } from '../ui/config.js'

export type ConfigCommandOptions = {
  color?: boolean
  global?: boolean
  local?: boolean
  noColor?: boolean
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
  const interactive = !commandOptions.show && !commandOptions.strategy && !commandOptions.unset
  const [settings, setSettings] = useState<MrSettings | null>(null)
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
    void runConfigAction(commandOptions, context, interactive, setSettings)
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
    void saveStrategy(selection, context)
      .then(() => exit())
      .catch(fail)
  }, [context, exit, fail, saving, selection])

  if (interactive && settings && !saving) {
    return <ConfigPicker ui={context.ui} settings={settings} onSelect={setSelection} onCancel={cancel} />
  }

  return null
}

async function runConfigAction(
  options: ConfigCommandOptions,
  context: ReturnType<typeof createContext>,
  interactive: boolean,
  setSettings: (settings: MrSettings) => void,
) {
  assertValidOptions(options)

  if (options.show) {
    printSettings(await readMrSettings(context), context)
    return true
  }

  if (options.unset) {
    const scope = await resolveWriteScope(options, context)
    const changed = await unsetStrategyConfig(scope, context)
    context.ui.status(changed ? 'ok' : 'skip', `${scopeLabel(scope)} mr.strategy ${changed ? '已清除' : '未设置'}`)
    printSettings(await readMrSettings(context), context)
    return true
  }

  if (options.strategy) {
    const scope = await resolveWriteScope(options, context)
    await saveStrategy({ scope, strategy: options.strategy }, context)
    return true
  }

  if (interactive) {
    assertConfigInteractiveTerminal(process.stdin, process.stderr)
    setSettings(await readMrSettings(context))
    return false
  }

  return true
}

async function saveStrategy(selection: ConfigSelection, context: ReturnType<typeof createContext>) {
  await writeStrategyConfig(selection.strategy, selection.scope, context)
  context.ui.status('ok', `${scopeLabel(selection.scope)} mr.strategy=${selection.strategy}`)
  context.ui.status('info', strategyDescription(selection.strategy))
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

  if (options.unset && options.strategy) {
    throw new CliError('--unset 不能和 --strategy 同时使用。')
  }

  if (options.show && (options.unset || options.strategy)) {
    throw new CliError('--show 不能和修改配置的选项同时使用。')
  }
}

function printSettings(settings: MrSettings, context: ReturnType<typeof createContext>) {
  context.ui.panel('mr 设置', [
    `当前有效策略: ${settings.effective} (${sourceText(settings.source)})`,
    `当前仓库配置: ${settings.local ?? (settings.localAvailable ? '未设置' : '不可用')}`,
    `全局用户配置: ${settings.global ?? '未设置'}`,
  ])
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
