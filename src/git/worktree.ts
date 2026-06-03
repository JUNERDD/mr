import { CliError } from '../core/errors.js'
import { git, gitOutput } from './client.js'

export type WorktreeEntry = {
  branch: string | null
  head: string | null
  path: string
  prunable: boolean
}

export async function listWorktrees(context: any): Promise<WorktreeEntry[]> {
  const result = await git(['worktree', 'list', '--porcelain'], context, {
    quiet: true,
    allowFailure: true,
  })
  if (result.exitCode !== 0) {
    return []
  }

  const entries: WorktreeEntry[] = []
  let current: Partial<WorktreeEntry> = {}

  for (const line of result.stdout.split('\n')) {
    if (!line) {
      if (current.path) {
        entries.push({
          path: current.path,
          head: current.head ?? null,
          branch: current.branch ?? null,
          prunable: Boolean(current.prunable),
        })
      }
      current = {}
      continue
    }

    if (line.startsWith('worktree ')) {
      current.path = line.slice('worktree '.length)
      continue
    }

    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length)
      continue
    }

    if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//u, '')
      continue
    }

    if (line === 'prunable') {
      current.prunable = true
    }
  }

  if (current.path) {
    entries.push({
      path: current.path,
      head: current.head ?? null,
      branch: current.branch ?? null,
      prunable: Boolean(current.prunable),
    })
  }

  return entries
}

export async function addWorktree(path: string, branch: string, startPoint: string, context: any) {
  await git(['worktree', 'add', '-B', branch, path, startPoint], context, {
    label: `创建 worktree ${path}`,
    mutates: true,
  })
}

export async function removeWorktree(path: string, context: any) {
  await git(['worktree', 'remove', '--force', path], context, {
    allowFailure: true,
    label: `删除 worktree ${path}`,
    mutates: true,
  })
  await git(['worktree', 'prune'], context, {
    allowFailure: true,
    quiet: true,
    mutates: true,
  })
}

export async function getRepositoryTopLevel(context: any) {
  const top = await gitOutput(['rev-parse', '--show-toplevel'], context)
  if (!top) {
    throw new CliError('无法读取仓库根目录。')
  }

  return top
}
