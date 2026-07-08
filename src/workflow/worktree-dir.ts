import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CliError } from '../core/errors.js'
import { isGitWorkTree, scopeLabel, type ConfigScope } from '../core/settings.js'
import { gitOutput } from '../git/client.js'
import { getRepositoryTopLevel } from '../git/worktree.js'

export type WorktreeDirSource = 'environment' | 'local' | 'global' | 'builtin'

export type WorktreeDirSettings = {
  effective: string
  global: string | null
  local: string | null
  localAvailable: boolean
  source: WorktreeDirSource
}

export async function readWorktreeDirSettings(context: any, repositoryTop?: string): Promise<WorktreeDirSettings> {
  const localAvailable = await isGitWorkTree(context)
  const base = repositoryTop ?? (localAvailable ? await getRepositoryTopLevel(context) : context.cwd || process.cwd())
  const env = normalizeConfiguredPath(context.env?.MR_WORKTREE_DIR, base)
  const local = localAvailable ? normalizeConfiguredPath(await readScopeWorktreeDir('local', context), base) : null
  const global = normalizeConfiguredPath(await readScopeWorktreeDir('global', context), base)

  if (env) {
    return { effective: env, global, local, localAvailable, source: 'environment' }
  }

  if (local) {
    return { effective: local, global, local, localAvailable, source: 'local' }
  }

  if (global) {
    return { effective: global, global, local, localAvailable, source: 'global' }
  }

  return { effective: join(tmpdir(), 'mr-worktrees'), global, local, localAvailable, source: 'builtin' }
}

export async function resolveDetachedWorktreePath(mrBranch: string, context: any) {
  const top = await getRepositoryTopLevel(context)
  const settings = await readWorktreeDirSettings(context, top)
  await ensureWorktreeRootReady(settings.effective, top, context)
  const hash = createHash('sha256').update(top).digest('hex').slice(0, 8)
  const safe = mrBranch.replace(/[^a-zA-Z0-9._-]+/gu, '_')
  return join(settings.effective, `${hash}-${safe}`)
}

export function worktreeDirSourceText(source: WorktreeDirSource) {
  if (source === 'environment') {
    return 'MR_WORKTREE_DIR 环境变量'
  }

  if (source === 'local' || source === 'global') {
    return `${scopeLabel(source)} 配置`
  }

  return '内置临时目录'
}

async function ensureWorktreeRootReady(root: string, repositoryTop: string, context: any) {
  if (samePath(root, repositoryTop)) {
    throw new CliError('mr.worktreeDir 不能指向仓库根目录。', {
      next: ['改用子目录，例如: git config mr.worktreeDir .mr-worktrees'],
    })
  }

  if (isInside(join(repositoryTop, '.git'), root)) {
    throw new CliError('mr.worktreeDir 不能放在 .git 目录内。', {
      next: ['改用仓库内普通子目录，例如: git config mr.worktreeDir .mr-worktrees'],
    })
  }

  await mkdir(root, { recursive: true })
  await excludeNestedWorktreeRoot(root, repositoryTop, context)
}

async function excludeNestedWorktreeRoot(root: string, repositoryTop: string, context: any) {
  if (!isInside(repositoryTop, root)) {
    return
  }

  const relativeRoot = toPosix(relative(repositoryTop, root))
  if (!relativeRoot || relativeRoot.includes('\n')) {
    return
  }

  const excludePath = await gitOutput(['rev-parse', '--git-path', 'info/exclude'], context)
  if (!excludePath) {
    return
  }

  const absoluteExcludePath = resolve(context.cwd || process.cwd(), excludePath)
  await mkdir(dirname(absoluteExcludePath), { recursive: true })
  const pattern = `${relativeRoot}/`
  const current = await readOptionalFile(absoluteExcludePath)
  if (current.split('\n').includes(pattern)) {
    return
  }

  const prefix = current.endsWith('\n') || !current ? '' : '\n'
  await appendFile(absoluteExcludePath, `${prefix}# mr conflict worktrees\n${pattern}\n`)
}

async function readScopeWorktreeDir(scope: ConfigScope, context: any) {
  return gitOutput(['config', scope === 'global' ? '--global' : '--local', '--get', 'mr.worktreeDir'], context)
}

async function readOptionalFile(path: string) {
  try {
    return await readFile(path, 'utf8')
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return ''
    }
    throw error
  }
}

function normalizeConfiguredPath(value: unknown, base: string) {
  const raw = String(value ?? '').trim()
  if (!raw) {
    return null
  }

  const expanded = raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded)
}

function isInside(parent: string, child: string) {
  const rel = relative(parent, child)
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function samePath(left: string, right: string) {
  return relative(left, right) === ''
}

function toPosix(path: string) {
  return path.split(sep).join('/')
}
