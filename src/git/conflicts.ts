import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, gitOutput } from './client.js'

type ConflictStages = {
  base?: string
  ours?: string
  theirs?: string
}

type RebaseConflictStages = {
  base: string
  ours: string
  theirs: string
}

type AddAddConflictStages = {
  ours: string
  theirs: string
}

export async function rewriteRebaseConflictMarkers(currentBranch: string, targetBranch: string, context: any) {
  const conflicts = await listUnmergedStages(context)
  if (!conflicts.size) {
    return
  }

  const conflictStyle = await getConflictStyleArgs(context)
  for (const [path, stages] of conflicts) {
    const { base, ours, theirs } = stages
    if (!ours || !theirs) {
      continue
    }

    const currentLabel = await getSideLabel(currentBranch, theirs, path, 'REBASE_HEAD', context)
    const targetLabel = await getSideLabel(`origin/${targetBranch}`, ours, path, 'HEAD', context)
    const result = base
      ? await mergeStageObjects({ base, ours, theirs }, conflictStyle, currentLabel, targetLabel, context)
      : await mergeAddAddStages({ ours, theirs }, conflictStyle, currentLabel, targetLabel, context)

    if (isMergeFileResultUsable(result)) {
      await writeFile(path, result.stdout)
    }
  }
}

async function listUnmergedStages(context: any) {
  const result = await git(['ls-files', '-u', '-z'], context, {
    allowFailure: true,
    quiet: true,
  })
  const conflicts = new Map<string, ConflictStages>()
  if (result.exitCode !== 0 || !result.stdout) {
    return conflicts
  }

  for (const entry of result.stdout.split('\0')) {
    if (!entry) {
      continue
    }

    const tabIndex = entry.indexOf('\t')
    if (tabIndex === -1) {
      continue
    }

    const meta = entry.slice(0, tabIndex).split(' ')
    const objectId = meta[1]
    const stage = Number(meta[2])
    const path = entry.slice(tabIndex + 1)
    if (!objectId || !path) {
      continue
    }

    const stages = conflicts.get(path) ?? {}
    if (stage === 1) {
      stages.base = objectId
    } else if (stage === 2) {
      stages.ours = objectId
    } else if (stage === 3) {
      stages.theirs = objectId
    }
    conflicts.set(path, stages)
  }

  return conflicts
}

async function getConflictStyleArgs(context: any) {
  const style = await gitOutput(['config', '--get', 'merge.conflictStyle'], context)
  if (style === 'diff3') {
    return ['--diff3']
  }

  if (style === 'zdiff3') {
    return ['--zdiff3']
  }

  return []
}

async function mergeStageObjects(
  stages: RebaseConflictStages,
  conflictStyle: string[],
  currentLabel: string,
  targetLabel: string,
  context: any,
) {
  return git(
    [
      'merge-file',
      '-p',
      '--object-id',
      ...conflictStyle,
      '-L',
      currentLabel,
      '-L',
      'merge base',
      '-L',
      targetLabel,
      stages.theirs,
      stages.base,
      stages.ours,
    ],
    context,
    {
      allowFailure: true,
      quiet: true,
    },
  )
}

async function mergeAddAddStages(
  stages: AddAddConflictStages,
  conflictStyle: string[],
  currentLabel: string,
  targetLabel: string,
  context: any,
) {
  const tmp = await mkdtemp(join(tmpdir(), 'mr-conflict-'))
  try {
    const currentPath = join(tmp, 'current')
    const basePath = join(tmp, 'base')
    const targetPath = join(tmp, 'target')
    const current = await git(['cat-file', '-p', stages.theirs], context, {
      allowFailure: true,
      quiet: true,
    })
    const target = await git(['cat-file', '-p', stages.ours], context, {
      allowFailure: true,
      quiet: true,
    })
    if (current.exitCode !== 0 || target.exitCode !== 0) {
      return current.exitCode !== 0 ? current : target
    }

    await writeFile(currentPath, current.stdout)
    await writeFile(basePath, '')
    await writeFile(targetPath, target.stdout)

    const result = await git(
      [
        'merge-file',
        '-p',
        ...conflictStyle,
        '-L',
        currentLabel,
        '-L',
        'empty base',
        '-L',
        targetLabel,
        currentPath,
        basePath,
        targetPath,
      ],
      context,
      {
        allowFailure: true,
        quiet: true,
      },
    )

    return result
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

async function getSideLabel(prefix: string, objectId: string, path: string, fallbackRev: string, context: any) {
  const commit =
    (await getObjectIntroducingCommit(objectId, path, context)) ??
    (await getObjectTouchingCommit(objectId, path, context)) ??
    (await gitOutput(['log', '-1', '--format=%h %an (%s)', fallbackRev], context))

  return [prefix, sanitizeLabel(commit)].filter(Boolean).join(' ')
}

async function getObjectIntroducingCommit(objectId: string, path: string, context: any) {
  return getObjectCommit(
    ['log', '--all', `--find-object=${objectId}`, '--diff-filter=A', '--format=%h %an (%s)', '--', path],
    context,
  )
}

async function getObjectTouchingCommit(objectId: string, path: string, context: any) {
  return getObjectCommit(['log', '--all', `--find-object=${objectId}`, '--format=%h %an (%s)', '--', path], context)
}

async function getObjectCommit(args: string[], context: any) {
  const output = await gitOutput(args, context)
  return output?.split('\n').find(Boolean) ?? null
}

function sanitizeLabel(label: string | null) {
  return label?.replace(/[\r\n]+/gu, ' ').trim()
}

function isMergeFileResultUsable(result: any) {
  return (
    result.exitCode > 0 && result.exitCode < 128 && result.stdout?.includes('<<<<<<< ') && !result.stdout.includes('\0')
  )
}
