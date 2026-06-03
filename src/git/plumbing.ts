import { CliError, compactOutput } from '../core/errors.js'
import { git, gitOutput } from './client.js'

export type MergeTreeResult = {
  conflict: boolean
  messages: string
  tree: string
}

function remoteHeadRef(branch: string) {
  return `refs/heads/${branch}`
}

export async function mergeTree(
  ours: string,
  theirs: string,
  context: any,
  { mergeBase }: { mergeBase?: string } = {},
): Promise<MergeTreeResult> {
  const args = ['merge-tree', '--write-tree', '--messages']
  if (mergeBase) {
    args.push(`--merge-base=${mergeBase}`)
  }
  args.push(ours, theirs)

  const result = await git(args, context, {
    allowFailure: true,
    quiet: true,
  })

  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new CliError(`无法执行 merge-tree: ${ours} + ${theirs}`, {
      exitCode: result.exitCode || 1,
      details: compactOutput(result.all),
      next: ['确认 Git 版本支持 merge-tree --write-tree。'],
    })
  }

  const lines = result.stdout.split('\n')
  const tree = lines[0]?.trim()
  if (!tree) {
    throw new CliError(`merge-tree 未返回 tree: ${ours} + ${theirs}`, {
      exitCode: result.exitCode || 1,
      details: compactOutput(result.all),
    })
  }

  return {
    tree,
    conflict: result.exitCode === 1,
    messages: lines.slice(1).join('\n'),
  }
}

export async function commitTree(tree: string, parents: string[], message: string, context: any): Promise<string> {
  const args = ['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-m', message]
  const oid = await gitOutput(args, context)
  if (!oid) {
    throw new CliError('commit-tree 未返回提交 OID。', {
      next: ['追加 --verbose 查看完整命令和输出。'],
    })
  }

  return oid.split('\n')[0]
}

export async function pushCommit(
  oid: string,
  branch: string,
  context: any,
  { force = false }: { force?: boolean } = {},
) {
  const args = ['push']
  if (force) {
    args.push('--force-with-lease')
  }
  args.push('origin', `${oid}:${remoteHeadRef(branch)}`)
  await git(args, context, {
    label: `推送 ${branch}`,
    mutates: true,
  })
}
