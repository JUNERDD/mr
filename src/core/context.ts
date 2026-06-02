import { createUi } from '../ui/terminal.js'

type ContextOptions = {
  color?: boolean
  deleteMrBranch?: boolean
  dryRun?: boolean
  env?: NodeJS.ProcessEnv
  merge?: boolean
  mergeTarget?: boolean
  quiet?: boolean
  pr?: boolean
  rebase?: boolean
  spinner?: boolean
  strategy?: string
  ui?: ReturnType<typeof createUi>
  verbose?: boolean
}

export function createContext(options: ContextOptions = {}) {
  const verboseFromEnv = String(options.env?.DEBUG ?? process.env.DEBUG ?? '')
    .split(',')
    .includes('mr')

  const verbose = Boolean(options.verbose || verboseFromEnv)
  const ui =
    options.ui ??
    createUi({
      color: options.color,
      verbose,
      quiet: options.quiet,
      spinner: options.spinner,
      env: options.env,
    })

  return {
    deleteMrBranch: Boolean(options.deleteMrBranch),
    dryRun: Boolean(options.dryRun),
    env: options.env ?? process.env,
    merge: Boolean(options.merge),
    mergeTarget: Boolean(options.mergeTarget),
    pr: Boolean(options.pr),
    rebase: Boolean(options.rebase),
    strategy: options.strategy,
    verbose,
    ui,
  }
}
