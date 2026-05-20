export const TARGET_BY_BIN: Record<string, string> = {
  mrm: 'master',
  mrt: 'test',
  mrp: 'prerelease',
}

export const INTERACTIVE_BIN = 'mr'
export const LIFECYCLE_COMMANDS = ['update', 'uninstall'] as const

export type LifecycleCommand = (typeof LIFECYCLE_COMMANDS)[number]

export const TARGET_OPTIONS = [
  { value: 'master', label: 'master', hint: '主分支' },
  { value: 'test', label: 'test', hint: '测试分支' },
  { value: 'prerelease', label: 'prerelease', hint: '预发布分支' },
]

export function isInteractiveInvocation(invokedName: string, targetArg?: string) {
  return invokedName === INTERACTIVE_BIN && !targetArg
}

export function normalizeHelpArgv(argv: string[]) {
  return argv.map((arg, index) => (index > 1 && arg === '-help' ? '--help' : arg))
}

export function resolveLifecycleCommand(invokedName: string, targetArg?: string): LifecycleCommand | undefined {
  if (invokedName !== INTERACTIVE_BIN) {
    return undefined
  }

  return LIFECYCLE_COMMANDS.find((command) => command === targetArg)
}

export function resolveTargetFromInvocation(invokedName: string, targetArg?: string) {
  if (TARGET_BY_BIN[invokedName]) {
    return TARGET_BY_BIN[invokedName]
  }

  return targetArg ? (TARGET_BY_BIN[targetArg] ?? targetArg) : undefined
}
