import type { Instance } from 'ink'
import { Box, render, Text, useInput } from 'ink'
import { useMemo, useState } from 'react'
import { CliError } from '../core/errors.js'
import { TARGET_OPTIONS } from '../core/targets.js'
import type { createUi } from './terminal.js'

type OutputStream = NodeJS.WritableStream & { isTTY?: boolean }
type InputStream = NodeJS.ReadableStream & { isTTY?: boolean }

type SelectTargetOptions = {
  input?: InputStream
  output?: OutputStream
  ui: ReturnType<typeof createUi>
}

type TargetPickerProps = {
  onCancel: () => void
  onSelect: (target: string) => void
  ui: ReturnType<typeof createUi>
}

export function createTargetChoices() {
  return TARGET_OPTIONS.map((option) => ({
    name: option.label,
    value: option.value,
    description: option.hint,
    short: option.value,
  }))
}

export function createSelectConfig(_ui: ReturnType<typeof createUi>) {
  return {
    message: '选择目标分支',
    choices: createTargetChoices(),
    pageSize: TARGET_OPTIONS.length,
    loop: true,
    theme: {
      indexMode: 'number',
    },
  } as const
}

export function assertInteractiveTerminal(input: InputStream = process.stdin, output: OutputStream = process.stderr) {
  if (!input.isTTY || !output.isTTY) {
    throw new CliError('mr 需要在交互式终端中选择目标分支。', {
      next: ['在脚本或 CI 中请直接使用: mr master、mr test 或 mr prerelease'],
    })
  }
}

export function TargetPicker({ onCancel, onSelect, ui }: TargetPickerProps) {
  const choices = useMemo(() => createTargetChoices(), [])
  const [activeIndex, setActiveIndex] = useState(0)
  const colorEnabled = ui.colors.isColorSupported

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onCancel()
      return
    }

    if (key.escape) {
      onCancel()
      return
    }

    if (input === 'q') {
      onCancel()
      return
    }

    if (key.upArrow || input === 'k') {
      setActiveIndex((index) => (index + choices.length - 1) % choices.length)
      return
    }

    if (key.downArrow || input === 'j') {
      setActiveIndex((index) => (index + 1) % choices.length)
      return
    }

    if (/^[1-9]$/.test(input)) {
      const nextIndex = Number(input) - 1
      if (choices[nextIndex]) {
        setActiveIndex(nextIndex)
      }
      return
    }

    if (key.return) {
      onSelect(choices[activeIndex].value)
    }
  })

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color={colorEnabled ? 'cyan' : undefined}>
          mr
        </Text>
        {'  目标分支'}
      </Text>
      {choices.map((choice, index) => {
        const active = index === activeIndex
        return (
          <Text key={choice.value} color={active && colorEnabled ? 'cyan' : undefined} bold={active}>
            {active ? '>' : ' '} {index + 1}. {choice.name}
            <Text dimColor={colorEnabled}> {choice.description}</Text>
          </Text>
        )
      })}
      <Text dimColor={colorEnabled}>上下 / 数字键 选择 回车 确认 q 取消</Text>
    </Box>
  )
}

export async function selectTarget({ input = process.stdin, output = process.stderr, ui }: SelectTargetOptions) {
  assertInteractiveTerminal(input, output)

  return new Promise<string>((resolve, reject) => {
    let instance: Instance | undefined
    const finish = (target: string) => {
      resolve(target)
      instance?.unmount()
    }
    const cancel = () => {
      reject(new CliError('已取消选择。', { exitCode: 130 }))
      instance?.unmount()
    }

    instance = render(<TargetPicker ui={ui} onSelect={finish} onCancel={cancel} />, {
      stdin: input as NodeJS.ReadStream,
      stdout: output as NodeJS.WriteStream,
      stderr: output as NodeJS.WriteStream,
      exitOnCtrlC: false,
    })
  })
}
