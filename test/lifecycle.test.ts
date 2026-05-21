import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'vitest'
import { runLifecycleCommand } from '../src/runtime/lifecycle.js'

test('lifecycle commands fall back to remote scripts when install scripts are missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mr-lifecycle-'))
  const installRoot = join(root, 'share/mr')
  const binDir = join(root, 'bin')
  const capturePath = join(root, 'capture.txt')
  const fakeBash = join(binDir, 'bash')
  const commandPath = join(binDir, 'mr')

  try {
    await mkdir(join(installRoot, 'dist/commands'), { recursive: true })
    await mkdir(binDir, { recursive: true })
    await writeFile(join(installRoot, 'dist/index.js'), '')
    await writeFile(join(installRoot, 'dist/commands/index.js'), '')
    await writeFile(
      fakeBash,
      [
        '#!/bin/sh',
        'printf "args=%s\\nMR_INSTALL_DIR=%s\\nMR_BIN_DIR=%s\\nMR_LIFECYCLE_FALLBACK=%s\\n" "$*" "$MR_INSTALL_DIR" "$MR_BIN_DIR" "$MR_LIFECYCLE_FALLBACK" > "$MR_CAPTURE"',
      ].join('\n'),
    )
    await chmod(fakeBash, 0o755)

    const exitCode = await runLifecycleCommand('update', {
      argv: ['node', commandPath, '--update'],
      env: {
        ...process.env,
        MR_CAPTURE: capturePath,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
      moduleUrl: pathToFileURL(join(installRoot, 'dist/commands/index.js')).href,
    })

    assert.equal(exitCode, 0)

    const capture = await readFile(capturePath, 'utf8')
    assert.match(
      capture,
      /args=-c curl -fsSL https:\/\/raw\.githubusercontent\.com\/JUNERDD\/mr\/main\/install\.sh \| bash/u,
    )
    assert.match(capture, new RegExp(`MR_INSTALL_DIR=${escapeRegExp(installRoot)}`, 'u'))
    assert.match(capture, new RegExp(`MR_BIN_DIR=${escapeRegExp(binDir)}`, 'u'))
    assert.match(capture, /MR_LIFECYCLE_FALLBACK=remote/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
