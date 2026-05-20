import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'vitest'
import { buildDryRunCommands } from '../src/core/dry-run.js'
import { CliError } from '../src/core/errors.js'
import { formatCommand } from '../src/core/format.js'
import {
  isInteractiveInvocation,
  normalizeHelpArgv,
  resolveLifecycleCommand,
  resolveTargetFromInvocation,
} from '../src/core/targets.js'
import { createSelectConfig, selectTarget } from '../src/ui/select-target.js'
import { createUi, resolveColorEnabled } from '../src/ui/terminal.js'
import { withRecoveryDetails } from '../src/workflow/recovery.js'
import { resolveMrStrategy } from '../src/workflow/strategy.js'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const execFileAsync = promisify(execFile)

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        return listSourceFiles(path)
      }

      return /\.(ts|tsx)$/.test(entry.name) ? [path] : []
    }),
  )

  return files.flat()
}

test('resolveTargetFromInvocation maps short binaries to target branches', () => {
  assert.equal(resolveTargetFromInvocation('mrm'), 'master')
  assert.equal(resolveTargetFromInvocation('mrt'), 'test')
  assert.equal(resolveTargetFromInvocation('mrp'), 'prerelease')
})

test('resolveTargetFromInvocation maps short target aliases', () => {
  assert.equal(resolveTargetFromInvocation('mr', 'mrm'), 'master')
  assert.equal(resolveTargetFromInvocation('mr', 'release/2026-05'), 'release/2026-05')
})

test('mr without a target is interactive, explicit targets are not', () => {
  assert.equal(isInteractiveInvocation('mr'), true)
  assert.equal(isInteractiveInvocation('mr', 'test'), false)
  assert.equal(isInteractiveInvocation('mrm'), false)
})

test('mr reserves lifecycle subcommands', () => {
  assert.equal(resolveLifecycleCommand('mr', 'update'), 'update')
  assert.equal(resolveLifecycleCommand('mr', 'uninstall'), 'uninstall')
  assert.equal(resolveLifecycleCommand('mrm', 'update'), undefined)
})

test('normalizeHelpArgv maps mr -help to --help', () => {
  assert.deepEqual(normalizeHelpArgv(['node', 'mr', '-help']), ['node', 'mr', '--help'])
  assert.deepEqual(normalizeHelpArgv(['node', 'mr', '-h']), ['node', 'mr', '-h'])
})

test('selectTarget fails fast outside an interactive terminal', async () => {
  await assert.rejects(
    selectTarget({ input: { isTTY: false } as any, output: { isTTY: false } as any, ui: createUi() }),
    /交互式终端/,
  )
})

test('createSelectConfig maps the three target choices', () => {
  const ui = createUi({
    color: false,
    stream: {
      isTTY: false,
      write() {
        return true
      },
    } as any,
    env: {},
  })
  const config = createSelectConfig(ui)

  assert.equal(config.theme.indexMode, 'number')
  assert.deepEqual(
    config.choices.map((choice) => choice.value),
    ['master', 'test', 'prerelease'],
  )
})

test('formatCommand keeps shell-like output readable', () => {
  assert.equal(
    formatCommand('git', ['push', 'origin', 'HEAD:mr/master/feature/a']),
    'git push origin HEAD:mr/master/feature/a',
  )
  assert.equal(formatCommand('git', ['switch', 'feature with space']), 'git switch "feature with space"')
})

test('resolveColorEnabled follows explicit flags and terminal conventions', () => {
  assert.equal(resolveColorEnabled(true, { NO_COLOR: '1' }, { isTTY: false } as any), true)
  assert.equal(resolveColorEnabled(false, { FORCE_COLOR: '1' }, { isTTY: true } as any), false)
  assert.equal(resolveColorEnabled(undefined, { NO_COLOR: '1' }, { isTTY: true } as any), false)
  assert.equal(resolveColorEnabled(undefined, { MR_NO_COLOR: '1' }, { isTTY: true } as any), false)
  assert.equal(resolveColorEnabled(undefined, { TERM: 'dumb' }, { isTTY: true } as any), false)
  assert.equal(resolveColorEnabled(undefined, { FORCE_COLOR: '1' }, { isTTY: false } as any), true)
  assert.equal(resolveColorEnabled(undefined, {}, { isTTY: true } as any), true)
})

test('buildDryRunCommands includes the core MR workflow', () => {
  const commands = buildDryRunCommands('test', 'feature/demo')
  const rendered = commands.map(({ command, args }) => formatCommand(command, args))

  assert.deepEqual(rendered, [
    'git fetch origin +test:refs/remotes/origin/test',
    'git ls-remote --exit-code --heads origin mr/test/feature/demo',
    'git push origin HEAD:mr/test/feature/demo',
    'git cnb pull create -H mr/test/feature/demo -B test',
    'git switch -C mr/test/feature/demo origin/test',
    'git branch --set-upstream-to origin/mr/test/feature/demo mr/test/feature/demo',
    'git merge --no-edit feature/demo',
    'git push origin HEAD:mr/test/feature/demo',
    'git switch feature/demo',
  ])
})

test('buildDryRunCommands supports the rebase strategy', () => {
  const commands = buildDryRunCommands('test', 'feature/demo', 'rebase')
  const rendered = commands.map(({ command, args }) => formatCommand(command, args))

  assert.deepEqual(rendered, [
    'git fetch origin +test:refs/remotes/origin/test',
    'git ls-remote --exit-code --heads origin mr/test/feature/demo',
    'git switch -C mr/test/feature/demo feature/demo',
    'git merge-base origin/test feature/demo',
    'git rebase --onto origin/test MERGE_BASE mr/test/feature/demo',
    'git push --force-with-lease --set-upstream origin HEAD:mr/test/feature/demo',
    'git cnb pull create -H mr/test/feature/demo -B test',
    'git switch feature/demo',
  ])
})

test('buildDryRunCommands supports the merge-target strategy', () => {
  const commands = buildDryRunCommands('test', 'feature/demo', 'merge-target')
  const rendered = commands.map(({ command, args }) => formatCommand(command, args))

  assert.deepEqual(rendered, [
    'git fetch origin +test:refs/remotes/origin/test',
    'git ls-remote --exit-code --heads origin mr/test/feature/demo',
    'git switch -C mr/test/feature/demo feature/demo',
    'git merge --no-edit origin/test',
    'git push --force-with-lease --set-upstream origin HEAD:mr/test/feature/demo',
    'git cnb pull create -H mr/test/feature/demo -B test',
    'git switch feature/demo',
  ])
})

test('buildDryRunCommands supports direct PR creation from the current branch', () => {
  const commands = buildDryRunCommands('test', 'feature/demo', 'pr')
  const rendered = commands.map(({ command, args }) => formatCommand(command, args))

  assert.deepEqual(rendered, [
    'git fetch origin +test:refs/remotes/origin/test',
    'git push --set-upstream origin HEAD:feature/demo',
    'git cnb pull create -H feature/demo -B test',
  ])
})

test('resolveMrStrategy accepts flags and environment configuration', async () => {
  assert.equal(await resolveMrStrategy({ merge: true, env: { MR_STRATEGY: 'rebase' } }), 'merge')
  assert.equal(await resolveMrStrategy({ rebase: true }), 'rebase')
  assert.equal(await resolveMrStrategy({ mergeTarget: true }), 'merge-target')
  assert.equal(await resolveMrStrategy({ pr: true }), 'pr')
  assert.equal(await resolveMrStrategy({ env: { MR_STRATEGY: 'merge_target' } }), 'merge-target')
})

test('resolveMrStrategy reads git config when no flag or environment override exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-strategy-'))
  const originalCwd = process.cwd()

  try {
    await execFileAsync('git', ['init'], { cwd: root })
    await execFileAsync('git', ['config', 'mr.strategy', 'merge-target'], { cwd: root })
    process.chdir(root)

    assert.equal(await resolveMrStrategy({ env: {} }), 'merge-target')
  } finally {
    process.chdir(originalCwd)
    await rm(root, { recursive: true, force: true })
  }
})

test('resolveMrStrategy rejects conflicting strategy flags', async () => {
  await assert.rejects(resolveMrStrategy({ pr: true, rebase: true }), /只能指定一个 MR 策略选项/)
})

test('withRecoveryDetails preserves the original error and records branch recovery', () => {
  const error = new CliError('合并失败。', {
    exitCode: 7,
    details: ['merge output'],
    next: ['处理冲突'],
  })

  const recovered = withRecoveryDetails(error, {
    attempted: true,
    branch: 'feature/demo',
    details: ['已自动回到初始分支: feature/demo'],
    restored: true,
  })

  assert.equal(recovered.message, '合并失败。')
  assert.equal(recovered.exitCode, 7)
  assert.deepEqual(recovered.details, ['merge output', '已自动回到初始分支: feature/demo'])
  assert.deepEqual(recovered.next, ['处理冲突'])
})

test('source files stay below the 300 line module limit', async () => {
  const sourceFiles = await listSourceFiles(join(projectRoot, 'src'))

  for (const file of sourceFiles) {
    const source = await readFile(file, 'utf8')
    const lineCount = source.trimEnd().split('\n').length
    assert.ok(lineCount <= 300, `${file} has ${lineCount} lines`)
  }
})
