import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'vitest'
import { createContext } from '../src/core/context.js'
import { CliError } from '../src/core/errors.js'
import { createUi } from '../src/ui/terminal.js'
import { createMrFromTargetBranch } from '../src/workflow/create-mr.js'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]) {
  await execFileAsync('git', args, { cwd })
}

async function gitOutput(cwd: string, args: string[]) {
  const result = await execFileAsync('git', args, { cwd })
  return result.stdout.trim()
}

function quietUi() {
  return createUi({
    quiet: true,
    stream: {
      isTTY: false,
      write() {
        return true
      },
    } as any,
  })
}

async function setupRepo(root: string, { conflicting = false } = {}) {
  const remote = join(root, 'origin.git')
  const repo = join(root, 'repo')
  await mkdir(repo)

  await git(root, ['init', '--bare', remote])
  await git(repo, ['init'])
  await git(repo, ['config', 'user.name', 'Test User'])
  await git(repo, ['config', 'user.email', 'test@example.com'])
  await writeFile(join(repo, 'README.md'), 'base\n')
  await git(repo, ['add', 'README.md'])
  await git(repo, ['commit', '-m', 'base'])
  await git(repo, ['branch', '-M', 'main'])
  await git(repo, ['remote', 'add', 'origin', remote])
  await git(repo, ['push', '-u', 'origin', 'main'])

  await git(repo, ['switch', '-c', 'test'])
  if (conflicting) {
    await writeFile(join(repo, 'file.txt'), 'target\n')
    await git(repo, ['add', 'file.txt'])
    await git(repo, ['commit', '-m', 'target'])
  } else {
    await writeFile(join(repo, 'target.txt'), 'target\n')
    await git(repo, ['add', 'target.txt'])
    await git(repo, ['commit', '-m', 'target'])
  }
  await git(repo, ['push', '-u', 'origin', 'test'])

  await git(repo, ['switch', 'main'])
  await git(repo, ['switch', '-c', 'feature/demo'])
  if (conflicting) {
    await writeFile(join(repo, 'file.txt'), 'feature\n')
    await git(repo, ['add', 'file.txt'])
    await git(repo, ['commit', '-m', 'feature'])
  } else {
    await writeFile(join(repo, 'feature.txt'), 'feature\n')
    await git(repo, ['add', 'feature.txt'])
    await git(repo, ['commit', '-m', 'feature'])
  }

  return { repo }
}

test('default detached merge keeps current branch and dirty working tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-detached-merge-'))
  const originalCwd = process.cwd()

  try {
    const { repo } = await setupRepo(root)
    await writeFile(join(repo, 'local-only.txt'), 'wip\n')

    process.chdir(repo)

    const context = createContext({ ui: quietUi() })
    await createMrFromTargetBranch('test', context)

    assert.equal(await gitOutput(repo, ['branch', '--show-current']), 'feature/demo')
    assert.equal(await readFile(join(repo, 'local-only.txt'), 'utf8'), 'wip\n')
    await git(repo, ['merge-base', '--is-ancestor', 'feature/demo', 'origin/mr/test/feature/demo'])
    assert.equal(
      await gitOutput(repo, ['rev-list', '--merges', '--count', 'origin/test..origin/mr/test/feature/demo']),
      '1',
    )

    // 无改动重跑不应堆叠空合并提交，MR 分支顶端保持不变。
    const before = await gitOutput(repo, ['rev-parse', 'origin/mr/test/feature/demo'])
    await createMrFromTargetBranch('test', createContext({ ui: quietUi() }))
    assert.equal(await gitOutput(repo, ['rev-parse', 'origin/mr/test/feature/demo']), before)
    assert.equal(
      await gitOutput(repo, ['rev-list', '--merges', '--count', 'origin/test..origin/mr/test/feature/demo']),
      '1',
    )
  } finally {
    process.chdir(originalCwd)
    await rm(root, { recursive: true, force: true })
  }
})

test('detached merge conflict uses worktree and resumes from main repo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-detached-conflict-'))
  const originalCwd = process.cwd()

  try {
    const { repo } = await setupRepo(root, { conflicting: true })
    await git(repo, ['config', 'mr.worktreeDir', '.mr-worktrees'])
    process.chdir(repo)

    const context = createContext({ detached: true, ui: quietUi() })
    await assert.rejects(createMrFromTargetBranch('test', context), CliError)

    assert.equal(await gitOutput(repo, ['branch', '--show-current']), 'feature/demo')
    const worktrees = await gitOutput(repo, ['worktree', 'list', '--porcelain'])
    assert.match(worktrees, /worktree /)

    const wtPath = worktrees
      .split('\n\n')
      .map((block) => block.split('\n'))
      .find((lines) => lines.some((line) => line.includes('mr/test/feature/demo')))
      ?.find((line) => line.startsWith('worktree '))
      ?.slice('worktree '.length)
    assert.ok(wtPath)
    const top = await gitOutput(repo, ['rev-parse', '--show-toplevel'])
    assert.ok(wtPath!.startsWith(join(top, '.mr-worktrees')))
    assert.equal(await gitOutput(repo, ['status', '--short']), '')

    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')
    assert.match(exclude, /^\.mr-worktrees\/$/mu)

    await writeFile(join(wtPath!, 'file.txt'), 'feature\n')
    await git(wtPath!, ['add', 'file.txt'])

    await createMrFromTargetBranch('test', context)

    assert.equal(await gitOutput(repo, ['branch', '--show-current']), 'feature/demo')
    await git(repo, ['merge-base', '--is-ancestor', 'feature/demo', 'origin/mr/test/feature/demo'])
  } finally {
    process.chdir(originalCwd)
    await rm(root, { recursive: true, force: true })
  }
})

test('detached merge-target conflict resumes from worktree and force-pushes over a divergent MR branch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-detached-mt-conflict-'))
  const originalCwd = process.cwd()

  try {
    const { repo } = await setupRepo(root, { conflicting: true })
    process.chdir(repo)

    // 预置一个与最终结果分叉的远程 MR 分支（含 feature/demo 与 test 都没有的提交），
    // 这样普通推送会被 non-fast-forward 拒绝，只有 force-with-lease 才能成功。
    await git(repo, ['switch', '-c', 'mr-seed', 'main'])
    await writeFile(join(repo, 'seed.txt'), 'seed\n')
    await git(repo, ['add', 'seed.txt'])
    await git(repo, ['commit', '-m', 'seed'])
    await git(repo, ['push', 'origin', 'mr-seed:refs/heads/mr/test/feature/demo'])
    await git(repo, ['switch', 'feature/demo'])
    await git(repo, ['branch', '-D', 'mr-seed'])

    const context = createContext({ detached: true, mergeTarget: true, ui: quietUi() })
    await assert.rejects(createMrFromTargetBranch('test', context), CliError)

    const worktrees = await gitOutput(repo, ['worktree', 'list', '--porcelain'])
    const wtPath = worktrees
      .split('\n\n')
      .map((block) => block.split('\n'))
      .find((lines) => lines.some((line) => line.includes('mr/test/feature/demo')))
      ?.find((line) => line.startsWith('worktree '))
      ?.slice('worktree '.length)
    assert.ok(wtPath)

    await writeFile(join(wtPath!, 'file.txt'), 'feature\n')
    await git(wtPath!, ['add', 'file.txt'])

    await createMrFromTargetBranch('test', context)

    assert.equal(await gitOutput(repo, ['branch', '--show-current']), 'feature/demo')
    await git(repo, ['merge-base', '--is-ancestor', 'origin/test', 'origin/mr/test/feature/demo'])
    await git(repo, ['merge-base', '--is-ancestor', 'feature/demo', 'origin/mr/test/feature/demo'])
    // force-with-lease 用当前分支结果覆盖了分叉分支，seed 提交不应出现在最终 MR 分支里。
    await assert.rejects(git(repo, ['cat-file', '-e', 'origin/mr/test/feature/demo:seed.txt']))
    // worktree 收尾应被清理。
    const remaining = await gitOutput(repo, ['worktree', 'list', '--porcelain'])
    assert.doesNotMatch(remaining, /mr\/test\/feature\/demo/)
  } finally {
    process.chdir(originalCwd)
    await rm(root, { recursive: true, force: true })
  }
})

test('detached merge-target updates remote MR branch without switching', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-detached-mt-'))
  const originalCwd = process.cwd()

  try {
    const { repo } = await setupRepo(root)
    process.chdir(repo)

    const context = createContext({ detached: true, mergeTarget: true, ui: quietUi() })
    await createMrFromTargetBranch('test', context)

    assert.equal(await gitOutput(repo, ['branch', '--show-current']), 'feature/demo')
    await git(repo, ['merge-base', '--is-ancestor', 'origin/test', 'origin/mr/test/feature/demo'])
    await git(repo, ['merge-base', '--is-ancestor', 'feature/demo', 'origin/mr/test/feature/demo'])
  } finally {
    process.chdir(originalCwd)
    await rm(root, { recursive: true, force: true })
  }
})
