import { useApp } from 'ink'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { getCurrentArgv } from '../cli/runtime-state.js'
import { createContext } from '../core/context.js'
import { CliError, compactOutput } from '../core/errors.js'
import type { RequestCommandSettings } from '../core/request-command.js'
import type { DetachedSettings, MrSettings } from '../core/settings.js'
import { type ConfigSelection, ConfigPicker } from '../ui/config.js'
import { type ConfigCommandOptions, runConfigAction, saveConfig } from './config-action.js'

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
    !commandOptions.requestCommand &&
    !commandOptions.requestProvider &&
    !commandOptions.unset &&
    !commandOptions.unsetRequestCommand &&
    !commandOptions.unsetRequestProvider &&
    !commandOptions.detached &&
    !commandOptions.noDetached
  const [settings, setSettings] = useState<MrSettings | null>(null)
  const [detachedSettings, setDetachedSettings] = useState<DetachedSettings | null>(null)
  const [requestCommandSettings, setRequestCommandSettings] = useState<RequestCommandSettings | null>(null)
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
    void runConfigAction(
      commandOptions,
      context,
      interactive,
      setSettings,
      setDetachedSettings,
      setRequestCommandSettings,
    )
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

  if (interactive && settings && detachedSettings && requestCommandSettings && !saving) {
    return (
      <ConfigPicker
        ui={context.ui}
        settings={settings}
        detachedSettings={detachedSettings}
        requestCommandSettings={requestCommandSettings}
        onSelect={setSelection}
        onCancel={cancel}
      />
    )
  }

  return null
}
