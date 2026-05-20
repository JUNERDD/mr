import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CliError } from '../core/errors.js'
import type { LifecycleCommand } from '../core/targets.js'

const BIN_NAMES = new Set(['mr', 'mrm', 'mrt', 'mrp'])

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
  for (const root of rootCandidates(moduleUrl)) {
    const scriptPath = join(root, scriptName)
    if (await exists(scriptPath)) {
      return { root, scriptPath }
    }
  }

  throw new CliError(`找不到 ${scriptName}，无法执行 mr ${command}。`, {
    next: ['重新执行安装命令，或检查当前 mr 是否来自完整安装目录。'],
  })
}

function spawnBash(scriptPath: string, env: NodeJS.ProcessEnv) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn('bash', [scriptPath], { env, stdio: 'inherit' })
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
  const { root, scriptPath } = await findLifecycleScript(command, moduleUrl)
  const nextEnv = { ...env }

  nextEnv.MR_INSTALL_DIR ??= root

  const inferredBinDir = binDirFromArgv(argv)
  if (inferredBinDir) {
    nextEnv.MR_BIN_DIR ??= inferredBinDir
  }

  return spawnBash(scriptPath, nextEnv)
}
