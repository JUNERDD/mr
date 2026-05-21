import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CliError } from '../core/errors.js'

export type LifecycleCommand = 'uninstall' | 'update'

const BIN_NAMES = new Set(['mr', 'mrm', 'mrt', 'mrp'])
const REMOTE_SCRIPTS: Record<LifecycleCommand, string> = {
  uninstall: 'https://raw.githubusercontent.com/JUNERDD/mr/main/uninstall.sh',
  update: 'https://raw.githubusercontent.com/JUNERDD/mr/main/install.sh',
}

async function exists(path: string) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function rootCandidates(moduleUrl: string) {
  const moduleDir = dirname(fileURLToPath(moduleUrl))
  return [resolve(moduleDir, '..'), resolve(moduleDir, '../..')]
}

function binDirFromArgv(argv: string[]) {
  const entry = argv[1]
  if (!entry || !BIN_NAMES.has(basename(entry))) {
    return undefined
  }

  return dirname(entry)
}

async function findLifecycleScript(command: LifecycleCommand, moduleUrl: string) {
  const scriptName = command === 'update' ? 'install.sh' : 'uninstall.sh'
  const candidates = rootCandidates(moduleUrl)
  for (const root of candidates) {
    const scriptPath = join(root, scriptName)
    if (await exists(scriptPath)) {
      return { args: [scriptPath], root, source: 'local' as const }
    }
  }

  return {
    args: ['-c', `curl -fsSL ${REMOTE_SCRIPTS[command]} | bash`],
    root: await resolveInstallRoot(candidates),
    source: 'remote' as const,
  }
}

async function resolveInstallRoot(candidates: string[]) {
  for (const root of candidates) {
    if (await exists(join(root, 'dist/index.js'))) {
      return root
    }
  }

  return candidates[0]
}

function spawnBash(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn('bash', args, { env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (signal) {
        reject(new CliError(`脚本被信号 ${signal} 中断。`))
        return
      }

      resolve(code ?? 1)
    })
  })
}

export async function runLifecycleCommand(
  command: LifecycleCommand,
  { argv = process.argv, env = process.env, moduleUrl = import.meta.url } = {},
) {
  const { args, root, source } = await findLifecycleScript(command, moduleUrl)
  const nextEnv = { ...env }

  nextEnv.MR_INSTALL_DIR ??= root

  const inferredBinDir = binDirFromArgv(argv)
  if (inferredBinDir) {
    nextEnv.MR_BIN_DIR ??= inferredBinDir
  }

  if (source === 'remote') {
    nextEnv.MR_LIFECYCLE_FALLBACK ??= 'remote'
  }

  return spawnBash(args, nextEnv)
}
