import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'vitest'
import { createContext } from '../src/core/context.js'
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

test('creates the MR branch by merging current changes by default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-merge-'))
  const originalCwd = process.cwd()
  const originalPath = process.env.PATH

  try {
    const remote = join(root, 'origin.git')
    const repo = join(root, 'repo')
    const bin = join(root, 'bin')
    await mkdir(repo)
    await mkdir(bin)
    await writeFile(
      join(bin, 'git-cnb'),
      [
        '#!/bin/sh',
        'if [ "$1" = "-h" ]; then exit 0; fi',
        'if [ "$1" = "pull" ] && [ "$2" = "create" ]; then exit 1; fi',
        'echo "unexpected git cnb $*" >&2',
        'exit 1',
        '',
      ].join('\n'),
    )
    await chmod(join(bin, 'git-cnb'), 0o755)

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
    await writeFile(join(repo, 'target.txt'), 'target\n')
    await git(repo, ['add', 'target.txt'])
    await git(repo, ['commit', '-m', 'target'])
    await git(repo, ['push', '-u', 'origin', 'test'])

    await git(repo, ['switch', 'main'])
    await git(repo, ['switch', '-c', 'feature/demo'])
    await writeFile(join(repo, 'feature.txt'), 'feature\n')
    await git(repo, ['add', 'feature.txt'])
    await git(repo, ['commit', '-m', 'feature'])

    process.chdir(repo)
    process.env.PATH = `${bin}:${originalPath ?? ''}`

    const context = createContext({
      ui: createUi({
        quiet: true,
        stream: {
          isTTY: false,
          write() {
            return true
          },
        } as any,
      }),
    })

    await createMrFromTargetBranch('test', context)

    assert.equal(await gitOutput(repo, ['branch', '--show-current']), 'feature/demo')
    await git(repo, ['merge-base', '--is-ancestor', 'origin/test', 'origin/mr/test/feature/demo'])
    await git(repo, ['merge-base', '--is-ancestor', 'feature/demo', 'origin/mr/test/feature/demo'])
    assert.equal(
      await gitOutput(repo, ['rev-list', '--merges', '--count', 'origin/test..origin/mr/test/feature/demo']),
      '1',
    )
  } finally {
    process.chdir(originalCwd)
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('creates a PR directly from the current branch when requested', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-pr-'))
  const originalCwd = process.cwd()
  const originalPath = process.env.PATH

  try {
    const remote = join(root, 'origin.git')
    const repo = join(root, 'repo')
    const bin = join(root, 'bin')
    await mkdir(repo)
    await mkdir(bin)
    await writeFile(
      join(bin, 'git-cnb'),
      [
        '#!/bin/sh',
        'if [ "$1" = "-h" ]; then exit 0; fi',
        'if [ "$1" = "pull" ] && [ "$2" = "create" ]; then exit 1; fi',
        'echo "unexpected git cnb $*" >&2',
        'exit 1',
        '',
      ].join('\n'),
    )
    await chmod(join(bin, 'git-cnb'), 0o755)

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
    await writeFile(join(repo, 'target.txt'), 'target\n')
    await git(repo, ['add', 'target.txt'])
    await git(repo, ['commit', '-m', 'target'])
    await git(repo, ['push', '-u', 'origin', 'test'])

    await git(repo, ['switch', 'main'])
    await git(repo, ['switch', '-c', 'feature/demo'])
    await writeFile(join(repo, 'feature.txt'), 'feature\n')
    await git(repo, ['add', 'feature.txt'])
    await git(repo, ['commit', '-m', 'feature'])

    process.chdir(repo)
    process.env.PATH = `${bin}:${originalPath ?? ''}`

    const context = createContext({
      pr: true,
      ui: createUi({
        quiet: true,
        stream: {
          isTTY: false,
          write() {
            return true
          },
        } as any,
      }),
    })

    await createMrFromTargetBranch('test', context)

    assert.equal(await gitOutput(repo, ['branch', '--show-current']), 'feature/demo')
    assert.equal(
      await gitOutput(repo, ['rev-parse', 'origin/feature/demo']),
      await gitOutput(repo, ['rev-parse', 'feature/demo']),
    )
    await assert.rejects(execFileAsync('git', ['rev-parse', 'origin/mr/test/feature/demo'], { cwd: repo }))
  } finally {
    process.chdir(originalCwd)
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('direct PR mode exits without pushing when current branch is already merged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-pr-merged-'))
  const originalCwd = process.cwd()
  const originalPath = process.env.PATH

  try {
    const remote = join(root, 'origin.git')
    const repo = join(root, 'repo')
    const bin = join(root, 'bin')
    await mkdir(repo)
    await mkdir(bin)
    await writeFile(
      join(bin, 'git-cnb'),
      [
        '#!/bin/sh',
        'if [ "$1" = "-h" ]; then exit 0; fi',
        'if [ "$1" = "pull" ] && [ "$2" = "create" ]; then exit 1; fi',
        'echo "unexpected git cnb $*" >&2',
        'exit 1',
        '',
      ].join('\n'),
    )
    await chmod(join(bin, 'git-cnb'), 0o755)

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

    await git(repo, ['switch', '-c', 'feature/demo'])
    await writeFile(join(repo, 'feature.txt'), 'feature\n')
    await git(repo, ['add', 'feature.txt'])
    await git(repo, ['commit', '-m', 'feature'])

    await git(repo, ['switch', '-c', 'test'])
    await git(repo, ['push', '-u', 'origin', 'test'])
    await git(repo, ['switch', 'feature/demo'])

    process.chdir(repo)
    process.env.PATH = `${bin}:${originalPath ?? ''}`

    const context = createContext({
      pr: true,
      ui: createUi({
        quiet: true,
        stream: {
          isTTY: false,
          write() {
            return true
          },
        } as any,
      }),
    })

    await createMrFromTargetBranch('test', context)

    assert.equal(await gitOutput(repo, ['branch', '--show-current']), 'feature/demo')
    await assert.rejects(execFileAsync('git', ['rev-parse', 'origin/feature/demo'], { cwd: repo }))
  } finally {
    process.chdir(originalCwd)
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('reuses an existing MR branch regardless of the requested MR strategy', async () => {
  const strategies = [
    { name: 'default', options: {} },
    { name: 'merge', options: { merge: true } },
    { name: 'rebase', options: { rebase: true } },
    { name: 'merge-target', options: { mergeTarget: true } },
  ]

  for (const strategy of strategies) {
    const root = await mkdtemp(join(tmpdir(), `mr-existing-${strategy.name}-`))
    const originalCwd = process.cwd()
    const originalPath = process.env.PATH

    try {
      const remote = join(root, 'origin.git')
      const repo = join(root, 'repo')
      const bin = join(root, 'bin')
      await mkdir(repo)
      await mkdir(bin)
      await writeFile(
        join(bin, 'git-cnb'),
        [
          '#!/bin/sh',
          'if [ "$1" = "-h" ]; then exit 0; fi',
          'if [ "$1" = "pull" ] && [ "$2" = "create" ]; then exit 0; fi',
          'echo "unexpected git cnb $*" >&2',
          'exit 1',
          '',
        ].join('\n'),
      )
      await chmod(join(bin, 'git-cnb'), 0o755)

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
      await writeFile(join(repo, 'target-one.txt'), 'target one\n')
      await git(repo, ['add', 'target-one.txt'])
      await git(repo, ['commit', '-m', 'target one'])
      await git(repo, ['push', '-u', 'origin', 'test'])

      await git(repo, ['switch', 'main'])
      await git(repo, ['switch', '-c', 'feature/demo'])
      await writeFile(join(repo, 'feature-one.txt'), 'feature one\n')
      await git(repo, ['add', 'feature-one.txt'])
      await git(repo, ['commit', '-m', 'feature one'])

      await git(repo, ['switch', '-c', 'mr/test/feature/demo'])
      await writeFile(join(repo, 'mr-only.txt'), 'mr only\n')
      await git(repo, ['add', 'mr-only.txt'])
      await git(repo, ['commit', '-m', 'mr only'])
      await git(repo, ['push', '-u', 'origin', 'HEAD:mr/test/feature/demo'])

      await git(repo, ['switch', 'test'])
      await writeFile(join(repo, 'target-two.txt'), 'target two\n')
      await git(repo, ['add', 'target-two.txt'])
      await git(repo, ['commit', '-m', 'target two'])
      await git(repo, ['push'])

      await git(repo, ['switch', 'feature/demo'])
      await writeFile(join(repo, 'feature-two.txt'), 'feature two\n')
      await git(repo, ['add', 'feature-two.txt'])
      await git(repo, ['commit', '-m', 'feature two'])

      process.chdir(repo)
      process.env.PATH = `${bin}:${originalPath ?? ''}`

      const context = createContext({
        ...strategy.options,
        ui: createUi({
          quiet: true,
          stream: {
            isTTY: false,
            write() {
              return true
            },
          } as any,
        }),
      })

      await createMrFromTargetBranch('test', context)

      assert.equal(await gitOutput(repo, ['branch', '--show-current']), 'feature/demo')
      await git(repo, ['merge-base', '--is-ancestor', 'feature/demo', 'origin/mr/test/feature/demo'])
      await git(repo, ['merge-base', '--is-ancestor', 'origin/test', 'origin/mr/test/feature/demo'])
      assert.equal(await gitOutput(repo, ['show', 'origin/mr/test/feature/demo:mr-only.txt']), 'mr only')
      assert.equal(await gitOutput(repo, ['show', 'origin/mr/test/feature/demo:feature-two.txt']), 'feature two')
      assert.equal(await gitOutput(repo, ['show', 'origin/mr/test/feature/demo:target-two.txt']), 'target two')
    } finally {
      process.chdir(originalCwd)
      if (originalPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = originalPath
      }
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('creates the MR branch from current changes before merging the target when requested', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-merge-target-'))
  const originalCwd = process.cwd()
  const originalPath = process.env.PATH

  try {
    const remote = join(root, 'origin.git')
    const repo = join(root, 'repo')
    const bin = join(root, 'bin')
    await mkdir(repo)
    await mkdir(bin)
    await writeFile(
      join(bin, 'git-cnb'),
      [
        '#!/bin/sh',
        'if [ "$1" = "-h" ]; then exit 0; fi',
        'if [ "$1" = "pull" ] && [ "$2" = "create" ]; then exit 0; fi',
        'echo "unexpected git cnb $*" >&2',
        'exit 1',
        '',
      ].join('\n'),
    )
    await chmod(join(bin, 'git-cnb'), 0o755)

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
    await writeFile(join(repo, 'target.txt'), 'target\n')
    await git(repo, ['add', 'target.txt'])
    await git(repo, ['commit', '-m', 'target'])
    await git(repo, ['push', '-u', 'origin', 'test'])

    await git(repo, ['switch', 'main'])
    await git(repo, ['switch', '-c', 'feature/demo'])
    await writeFile(join(repo, 'feature.txt'), 'feature\n')
    await git(repo, ['add', 'feature.txt'])
    await git(repo, ['commit', '-m', 'feature'])

    process.chdir(repo)
    process.env.PATH = `${bin}:${originalPath ?? ''}`

    const context = createContext({
      mergeTarget: true,
      ui: createUi({
        quiet: true,
        stream: {
          isTTY: false,
          write() {
            return true
          },
        } as any,
      }),
    })

    await createMrFromTargetBranch('test', context)

    assert.equal(await gitOutput(repo, ['branch', '--show-current']), 'feature/demo')
    await git(repo, ['merge-base', '--is-ancestor', 'feature/demo', 'origin/mr/test/feature/demo'])
    await git(repo, ['merge-base', '--is-ancestor', 'origin/test', 'origin/mr/test/feature/demo'])
    assert.equal(
      await gitOutput(repo, ['rev-list', '--merges', '--count', 'feature/demo..origin/mr/test/feature/demo']),
      '1',
    )
  } finally {
    process.chdir(originalCwd)
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('creates the MR branch by rebasing current changes when configured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-rebase-'))
  const originalCwd = process.cwd()
  const originalPath = process.env.PATH

  try {
    const remote = join(root, 'origin.git')
    const repo = join(root, 'repo')
    const bin = join(root, 'bin')
    await mkdir(repo)
    await mkdir(bin)
    await writeFile(
      join(bin, 'git-cnb'),
      [
        '#!/bin/sh',
        'if [ "$1" = "-h" ]; then exit 0; fi',
        'if [ "$1" = "pull" ] && [ "$2" = "create" ]; then exit 0; fi',
        'echo "unexpected git cnb $*" >&2',
        'exit 1',
        '',
      ].join('\n'),
    )
    await chmod(join(bin, 'git-cnb'), 0o755)

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
    await writeFile(join(repo, 'target.txt'), 'target\n')
    await git(repo, ['add', 'target.txt'])
    await git(repo, ['commit', '-m', 'target'])
    await git(repo, ['push', '-u', 'origin', 'test'])

    await git(repo, ['switch', 'main'])
    await git(repo, ['switch', '-c', 'feature/demo'])
    await writeFile(join(repo, 'feature.txt'), 'feature\n')
    await git(repo, ['add', 'feature.txt'])
    await git(repo, ['commit', '-m', 'feature'])

    process.chdir(repo)
    process.env.PATH = `${bin}:${originalPath ?? ''}`

    const context = createContext({
      rebase: true,
      ui: createUi({
        quiet: true,
        stream: {
          isTTY: false,
          write() {
            return true
          },
        } as any,
      }),
    })

    await createMrFromTargetBranch('test', context)

    assert.equal(await gitOutput(repo, ['branch', '--show-current']), 'feature/demo')
    await git(repo, ['merge-base', '--is-ancestor', 'origin/test', 'mr/test/feature/demo'])
    assert.equal(await gitOutput(repo, ['rev-list', '--merges', '--count', 'origin/test..mr/test/feature/demo']), '0')
    assert.equal(await gitOutput(repo, ['log', '--format=%s', 'origin/test..mr/test/feature/demo']), 'feature')
  } finally {
    process.chdir(originalCwd)
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
    await rm(root, { recursive: true, force: true })
  }
})
