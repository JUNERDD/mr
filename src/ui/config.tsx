import { Box, Text, useInput } from 'ink'
import { useMemo, useState } from 'react'
import type { RequestCommandSettings, RequestProvider } from '../core/request-command.js'
import type { ConfigScope, DetachedSettings, MrSettings, MrStrategy } from '../core/settings.js'
import type { createUi } from './terminal.js'
import {
  DETACHED_CHOICES,
  createConfigScopeChoices,
  createProviderChoices,
  createStrategyChoices,
  detachedSourceText,
  providerSourceText,
  sourceText,
} from './config-options.js'

export {
  assertConfigInteractiveTerminal,
  createConfigScopeChoices,
  createProviderChoices,
  createStrategyChoices,
} from './config-options.js'

export type ConfigSelection = {
  detached: boolean
  provider: RequestProvider
  scope: ConfigScope
  strategy: MrStrategy
}

type ConfigPickerProps = {
  detachedSettings: DetachedSettings
  onCancel: () => void
  onSelect: (selection: ConfigSelection) => void
  requestCommandSettings: RequestCommandSettings
  settings: MrSettings
  ui: ReturnType<typeof createUi>
}

type Stage = 'scope' | 'strategy' | 'detached' | 'provider'

export function ConfigPicker({
  detachedSettings,
  onCancel,
  onSelect,
  requestCommandSettings,
  settings,
  ui,
}: ConfigPickerProps) {
  const scopes = useMemo(() => createConfigScopeChoices(settings.localAvailable), [settings.localAvailable])
  const strategies = useMemo(() => createStrategyChoices(), [])
  const providers = useMemo(() => createProviderChoices(), [])
  const [stage, setStage] = useState<Stage>('scope')
  const [scopeIndex, setScopeIndex] = useState(0)
  const [strategyIndex, setStrategyIndex] = useState(() =>
    Math.max(
      0,
      strategies.findIndex((choice) => choice.value === settings.effective),
    ),
  )
  const [detachedIndex, setDetachedIndex] = useState(() =>
    Math.max(
      0,
      DETACHED_CHOICES.findIndex((choice) => choice.value === detachedSettings.effective),
    ),
  )
  const [providerIndex, setProviderIndex] = useState(() =>
    Math.max(
      0,
      providers.findIndex((choice) => choice.value === requestCommandSettings.provider),
    ),
  )
  const colorEnabled = ui.colors.isColorSupported
  const scope = scopes[scopeIndex]

  useInput((input, key) => {
    if ((key.ctrl && input === 'c') || key.escape || input === 'q') {
      onCancel()
      return
    }

    if (stage === 'strategy' && (key.leftArrow || input === 'h' || input === 'b')) {
      setStage('scope')
      return
    }

    if (stage === 'detached' && (key.leftArrow || input === 'h' || input === 'b')) {
      setStage('strategy')
      return
    }

    if (stage === 'provider' && (key.leftArrow || input === 'h' || input === 'b')) {
      setStage('detached')
      return
    }

    const choices =
      stage === 'scope'
        ? scopes
        : stage === 'strategy'
          ? strategies
          : stage === 'detached'
            ? DETACHED_CHOICES
            : providers
    const setIndex =
      stage === 'scope'
        ? setScopeIndex
        : stage === 'strategy'
          ? setStrategyIndex
          : stage === 'detached'
            ? setDetachedIndex
            : setProviderIndex

    if (key.upArrow || input === 'k') {
      setIndex((index) => (index + choices.length - 1) % choices.length)
      return
    }

    if (key.downArrow || input === 'j') {
      setIndex((index) => (index + 1) % choices.length)
      return
    }

    if (/^[1-9]$/u.test(input)) {
      const nextIndex = Number(input) - 1
      if (choices[nextIndex]) {
        setIndex(nextIndex)
      }
      return
    }

    if (key.return) {
      if (stage === 'scope') {
        setStage('strategy')
        return
      }

      if (stage === 'strategy') {
        setStage('detached')
        return
      }

      if (stage === 'detached') {
        setStage('provider')
        return
      }

      onSelect({
        scope: scope.value,
        strategy: strategies[strategyIndex].value,
        detached: DETACHED_CHOICES[detachedIndex].value,
        provider: providers[providerIndex].value,
      })
    }
  })

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color={colorEnabled ? 'cyan' : undefined}>
          mr
        </Text>
        {'  设置'}
      </Text>
      <Text>
        当前策略: <Text bold>{settings.effective}</Text>
        <Text dimColor={colorEnabled}> ({sourceText(settings.source)})</Text>
      </Text>
      <Text>
        无感模式: <Text bold>{detachedSettings.effective ? '开启' : '关闭'}</Text>
        <Text dimColor={colorEnabled}> ({detachedSourceText(detachedSettings.source)})</Text>
      </Text>
      <Text>
        请求 provider: <Text bold>{requestCommandSettings.provider}</Text>
        <Text dimColor={colorEnabled}> ({providerSourceText(requestCommandSettings.providerSource)})</Text>
      </Text>
      <Text dimColor={colorEnabled}>
        当前仓库: {settings.local ?? (settings.localAvailable ? '未设置' : '不可用')} / 全局用户:{' '}
        {settings.global ?? '未设置'}
      </Text>
      <Text> </Text>
      {stage === 'scope' ? renderScopeChoices(scopes, scopeIndex, colorEnabled) : null}
      {stage === 'strategy' ? renderStrategyChoices(strategies, strategyIndex, scope.label, colorEnabled) : null}
      {stage === 'detached' ? renderDetachedChoices(detachedIndex, scope.label, colorEnabled) : null}
      {stage === 'provider' ? renderProviderChoices(providers, providerIndex, scope.label, colorEnabled) : null}
      <Text dimColor={colorEnabled}>上下 / 数字键 选择 回车 确认 q 取消</Text>
      {stage === 'strategy' || stage === 'detached' || stage === 'provider' ? (
        <Text dimColor={colorEnabled}>左方向键 / b 返回上一步</Text>
      ) : null}
    </Box>
  )
}

function renderScopeChoices(
  scopes: ReturnType<typeof createConfigScopeChoices>,
  activeIndex: number,
  colorEnabled: boolean,
) {
  return (
    <>
      <Text bold>写入位置</Text>
      {scopes.map((choice, index) =>
        renderChoice(choice.value, choice.label, choice.description, index, activeIndex, colorEnabled),
      )}
    </>
  )
}

function renderStrategyChoices(
  strategies: ReturnType<typeof createStrategyChoices>,
  activeIndex: number,
  scope: string,
  colorEnabled: boolean,
) {
  return (
    <>
      <Text bold>默认策略 ({scope})</Text>
      {strategies.map((choice, index) =>
        renderChoice(choice.value, choice.label, choice.description, index, activeIndex, colorEnabled),
      )}
    </>
  )
}

function renderChoice(
  key: string,
  label: string,
  description: string,
  index: number,
  activeIndex: number,
  colorEnabled: boolean,
) {
  const active = index === activeIndex
  return (
    <Text key={key} color={active && colorEnabled ? 'cyan' : undefined} bold={active}>
      {active ? '>' : ' '} {index + 1}. {label}
      <Text dimColor={colorEnabled}> {description}</Text>
    </Text>
  )
}

function renderDetachedChoices(activeIndex: number, scope: string, colorEnabled: boolean) {
  return (
    <>
      <Text bold>无感模式 ({scope})</Text>
      {DETACHED_CHOICES.map((choice, index) =>
        renderChoice(String(choice.value), choice.label, choice.description, index, activeIndex, colorEnabled),
      )}
    </>
  )
}

function renderProviderChoices(
  providers: ReturnType<typeof createProviderChoices>,
  activeIndex: number,
  scope: string,
  colorEnabled: boolean,
) {
  return (
    <>
      <Text bold>请求 provider ({scope})</Text>
      {providers.map((choice, index) =>
        renderChoice(choice.value, choice.label, choice.description, index, activeIndex, colorEnabled),
      )}
    </>
  )
}
