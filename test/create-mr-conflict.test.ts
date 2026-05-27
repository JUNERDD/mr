import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

async function gitWithEnv(cwd: string, args: string[], env: NodeJS.ProcessEnv) {
  await execFileAsync('git', args, { cwd, env: { ...process.env, ...env } })
}

test('merge conflicts can be continued by running mr again after staging resolutions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-merge-conflict-'))
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
    await writeFile(join(repo, 'file.txt'), 'base\n')
    await git(repo, ['add', 'file.txt'])
    await git(repo, ['commit', '-m', 'base'])
    await git(repo, ['branch', '-M', 'main'])
    await git(repo, ['remote', 'add', 'origin', remote])
    await git(repo, ['push', '-u', 'origin', 'main'])

    await git(repo, ['switch', '-c', 'test'])
    await writeFile(join(repo, 'file.txt'), 'target\n')
    await git(repo, ['commit', '-am', 'target'])
    await git(repo, ['push', '-u', 'origin', 'test'])

    await git(repo, ['switch', 'main'])
    await git(repo, ['switch', '-c', 'feature/demo'])
    await writeFile(join(repo, 'file.txt'), 'feature\n')
    await git(repo, ['commit', '-am', 'feature'])

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

    await assert.rejects(createMrFromTargetBranch('test', context), CliError)

    assert.equal(await gitOutput(repo, ['branch', '--show-current']), 'mr/test/feature/demo')
    assert.match(await gitOutput(repo, ['rev-parse', '--verify', 'MERGE_HEAD']), /^[0-9a-f]{40}$/u)
    assert.match(await gitOutput(repo, ['status', '--porcelain']), /^UU file\.txt/m)
    assert.equal(
      await gitOutput(repo, ['rev-parse', 'origin/mr/test/feature/demo']),
      await gitOutput(repo, ['rev-parse', 'origin/test']),
    )
    assert.equal(
      await gitOutput(repo, [
        'rev-list',
        '--left-right',
        '--count',
        'mr/test/feature/demo...origin/mr/test/feature/demo',
      ]),
      '0\t0',
    )

    await writeFile(join(repo, 'file.txt'), 'feature\n')
    await git(repo, ['add', 'file.txt'])
    await createMrFromTargetBranch('test', context)

    assert.equal(await gitOutput(repo, ['branch', '--show-current']), 'feature/demo')
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

test('rebase conflicts leave the MR branch rebase unresolved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-conflict-'))
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
    await writeFile(join(repo, 'file.txt'), 'base\n')
    await git(repo, ['add', 'file.txt'])
    await git(repo, ['commit', '-m', 'base'])
    await git(repo, ['branch', '-M', 'main'])
    await git(repo, ['remote', 'add', 'origin', remote])
    await git(repo, ['push', '-u', 'origin', 'main'])

    await git(repo, ['switch', '-c', 'test'])
    await writeFile(join(repo, 'file.txt'), 'target\n')
    await writeFile(join(repo, 'added-on-both.txt'), 'target add\n')
    await git(repo, ['add', 'file.txt', 'added-on-both.txt'])
    await git(repo, ['commit', '-m', 'target'])
    await git(repo, ['push', '-u', 'origin', 'test'])

    await git(repo, ['switch', 'main'])
    await git(repo, ['switch', '-c', 'feature/demo'])
    await writeFile(join(repo, 'file.txt'), 'feature\n')
    await writeFile(join(repo, 'added-on-both.txt'), 'feature add\n')
    await git(repo, ['add', 'file.txt', 'added-on-both.txt'])
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

    await assert.rejects(createMrFromTargetBranch('test', context), (error: unknown) => {
      assert.ok(error instanceof CliError)
      assert.match(error.message, /发生冲突/)
      assert.equal(error.next[0], '当前处于 mr/test/feature/demo 的 rebase 冲突状态，请直接解决冲突。')
      return true
    })

    assert.equal(await gitOutput(repo, ['branch', '--show-current']), '')
    assert.match(await gitOutput(repo, ['rev-parse', '--verify', 'REBASE_HEAD']), /^[0-9a-f]{40}$/u)
    assert.match(await gitOutput(repo, ['status', '--porcelain']), /^UU file\.txt/m)
    assert.match(await gitOutput(repo, ['status', '--porcelain']), /^AA added-on-both\.txt/m)

    const conflictFile = await readFile(join(repo, 'file.txt'), 'utf8')
    assert.match(
      conflictFile,
      /^<<<<<<< feature\/demo [0-9a-f]+ Test User \(feature\)\nfeature\n=======\ntarget\n>>>>>>> origin\/test [0-9a-f]+ Test User \(target\)\n?$/u,
    )
    const addAddFile = await readFile(join(repo, 'added-on-both.txt'), 'utf8')
    assert.match(
      addAddFile,
      /^<<<<<<< feature\/demo [0-9a-f]+ Test User \(feature\)\nfeature add\n=======\ntarget add\n>>>>>>> origin\/test [0-9a-f]+ Test User \(target\)\n?$/u,
    )

    await writeFile(join(repo, 'file.txt'), 'feature\n')
    await writeFile(join(repo, 'added-on-both.txt'), 'feature add\n')
    await git(repo, ['add', 'file.txt', 'added-on-both.txt'])
    await createMrFromTargetBranch('test', context)

    assert.equal(await gitOutput(repo, ['branch', '--show-current']), 'feature/demo')
    assert.equal(await gitOutput(repo, ['log', '--format=%s', 'origin/test..origin/mr/test/feature/demo']), 'feature')

    const resolvedMrHead = await gitOutput(repo, ['rev-parse', 'origin/mr/test/feature/demo'])
    await createMrFromTargetBranch('test', context)

    assert.equal(await gitOutput(repo, ['branch', '--show-current']), 'feature/demo')
    assert.notEqual(await gitOutput(repo, ['rev-parse', 'origin/mr/test/feature/demo']), resolvedMrHead)
    await git(repo, ['merge-base', '--is-ancestor', 'feature/demo', 'origin/mr/test/feature/demo'])
    await git(repo, ['merge-base', '--is-ancestor', 'origin/test', 'origin/mr/test/feature/demo'])
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

test('rebase conflict labels preserve replayed commit authors without mislabeling the base side', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-conflict-authors-'))
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
    await git(repo, ['config', 'user.name', 'Integrator'])
    await git(repo, ['config', 'user.email', 'integrator@example.com'])
    await writeFile(join(repo, 'file.txt'), 'base\n')
    await git(repo, ['add', 'file.txt'])
    await git(repo, ['commit', '-m', 'base'])
    await git(repo, ['branch', '-M', 'main'])
    await git(repo, ['remote', 'add', 'origin', remote])
    await git(repo, ['push', '-u', 'origin', 'main'])

    await git(repo, ['switch', '-c', 'test'])
    await writeFile(join(repo, 'file.txt'), 'target\n')
    await gitWithEnv(repo, ['commit', '-am', 'target'], {
      GIT_AUTHOR_NAME: 'Target Author',
      GIT_AUTHOR_EMAIL: 'target@example.com',
    })
    await git(repo, ['push', '-u', 'origin', 'test'])

    await git(repo, ['switch', 'main'])
    await git(repo, ['switch', '-c', 'feature/demo'])
    await writeFile(join(repo, 'feature.txt'), 'one\n')
    await git(repo, ['add', 'feature.txt'])
    await gitWithEnv(repo, ['commit', '-m', 'feature one'], {
      GIT_AUTHOR_NAME: 'Feature One',
      GIT_AUTHOR_EMAIL: 'one@example.com',
    })
    await writeFile(join(repo, 'file.txt'), 'feature\n')
    await gitWithEnv(repo, ['commit', '-am', 'feature two'], {
      GIT_AUTHOR_NAME: 'Feature Two',
      GIT_AUTHOR_EMAIL: 'two@example.com',
    })

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

    await assert.rejects(createMrFromTargetBranch('test', context), CliError)

    const conflictFile = await readFile(join(repo, 'file.txt'), 'utf8')
    assert.match(
      conflictFile,
      /^<<<<<<< feature\/demo [0-9a-f]+ Feature Two \(feature two\)\nfeature\n=======\ntarget\n>>>>>>> origin\/test [0-9a-f]+ Target Author \(target\)\n?$/u,
    )

    await writeFile(join(repo, 'file.txt'), 'feature\n')
    await git(repo, ['add', 'file.txt'])
    await git(repo, ['-c', 'core.editor=true', 'rebase', '--continue'])

    assert.equal(
      await gitOutput(repo, ['log', '--reverse', '--format=%s <%an>', 'origin/test..mr/test/feature/demo']),
      ['feature one <Feature One>', 'feature two <Feature Two>'].join('\n'),
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
