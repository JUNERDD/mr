import { Box, Text, useInput } from 'ink'
import { useMemo, useState } from 'react'
import { CliError } from '../core/errors.js'
import type { ConfigScope, DetachedSettings, MrSettings, MrStrategy } from '../core/settings.js'
import { MR_STRATEGY_CHOICES, scopeLabel } from '../core/settings.js'
import type { createUi } from './terminal.js'

export type ConfigSelection = {
  detached: boolean
  scope: ConfigScope
  strategy: MrStrategy
}

const DETACHED_CHOICES = [
  { value: false, label: '关闭', description: '默认切换本地 MR 分支（内联模式）' },
  { value: true, label: '开启', description: '无感模式：不切本地分支，冲突时使用临时 worktree' },
] as const

type ConfigPickerProps = {
  detachedSettings: DetachedSettings
  onCancel: () => void
  onSelect: (selection: ConfigSelection) => void
  settings: MrSettings
  ui: ReturnType<typeof createUi>
}

type Stage = 'scope' | 'strategy' | 'detached'

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

export function assertConfigInteractiveTerminal(
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream & { isTTY?: boolean } = process.stderr,
) {
  if (!input.isTTY || !output.isTTY) {
    throw new CliError('mr --config 需要在交互式终端中设置默认策略。', {
      next: ['在脚本或 CI 中请使用: mr --config --strategy rebase 或 mr --config --global --strategy merge'],
    })
  }
}

export function ConfigPicker({ detachedSettings, onCancel, onSelect, settings, ui }: ConfigPickerProps) {
  const scopes = useMemo(() => createConfigScopeChoices(settings.localAvailable), [settings.localAvailable])
  const strategies = useMemo(() => createStrategyChoices(), [])
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

    const choices = stage === 'scope' ? scopes : stage === 'strategy' ? strategies : DETACHED_CHOICES
    const setIndex = stage === 'scope' ? setScopeIndex : stage === 'strategy' ? setStrategyIndex : setDetachedIndex

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

      onSelect({
        scope: scope.value,
        strategy: strategies[strategyIndex].value,
        detached: DETACHED_CHOICES[detachedIndex].value,
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
      <Text dimColor={colorEnabled}>
        当前仓库: {settings.local ?? (settings.localAvailable ? '未设置' : '不可用')} / 全局用户:{' '}
        {settings.global ?? '未设置'}
      </Text>
      <Text> </Text>
      {stage === 'scope' ? renderScopeChoices(scopes, scopeIndex, colorEnabled) : null}
      {stage === 'strategy' ? renderStrategyChoices(strategies, strategyIndex, scope.label, colorEnabled) : null}
      {stage === 'detached' ? renderDetachedChoices(detachedIndex, scope.label, colorEnabled) : null}
      <Text dimColor={colorEnabled}>上下 / 数字键 选择 回车 确认 q 取消</Text>
      {stage === 'strategy' || stage === 'detached' ? (
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
    return `${scopeLabel(source)} 配置`
  }

  if (source === 'legacy') {
    return '兼容 mr.rebase 配置'
  }

  return '内置默认'
}
