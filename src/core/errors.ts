export class CliError extends Error {
  exitCode: number
  details: string[]
  next: string[]

  constructor(
    message: string,
    { exitCode = 1, details = [], next = [] }: { exitCode?: number; details?: string[]; next?: string[] } = {},
  ) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
    this.details = details
    this.next = next
  }
}

export function compactOutput(output: unknown, maxLines = 12) {
  const lines = String(output ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)

  if (lines.length <= maxLines) {
    return lines
  }

  return [`... 省略 ${lines.length - maxLines} 行输出`, ...lines.slice(-maxLines)]
}
