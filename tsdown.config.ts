import { chmod } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { defineConfig } from 'tsdown'

const require = createRequire(import.meta.url)
const packageJson = require('./package.json') as { version: string }

const requireShim =
  'import{createRequire as __mrCreateRequire}from"node:module";const require=__mrCreateRequire(import.meta.url);'

export default defineConfig({
  entry: ['src/index.ts', 'src/commands/**/*.{ts,tsx}'],
  root: 'src',
  outDir: 'dist',
  platform: 'node',
  target: 'node20.12',
  format: 'esm',
  fixedExtension: false,
  minify: true,
  clean: true,
  dts: false,
  sourcemap: false,
  hash: true,
  outputOptions: {
    chunkFileNames: 'chunks/[name]-[hash].js',
  },
  deps: {
    onlyBundle: false,
  },
  define: {
    __PACKAGE_VERSION__: JSON.stringify(packageJson.version),
  },
  banner: {
    js: requireShim,
  },
  async onSuccess() {
    await chmod('dist/index.js', 0o755)
  },
})
