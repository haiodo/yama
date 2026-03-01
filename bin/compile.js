#!/usr/bin/env node

const { join } = require('path')

// Determine the correct path to the compiled module
const isDev = process.env.YAMA_DEV === '1'
const compileModulePath = isDev
  ? join(__dirname, '..', 'src', 'tools', 'compile.ts')
  : join(__dirname, '..', 'lib', 'tools', 'compile.js')

// In dev mode, use ts-node or tsx to run TypeScript directly
if (isDev) {
  const { spawn } = require('child_process')
  const tsxPath = require.resolve('tsx/cli')
  const args = [tsxPath, compileModulePath, ...process.argv.slice(2)]
  const child = spawn(process.execPath, args, {
    stdio: 'inherit',
    cwd: process.cwd()
  })
  child.on('exit', (code) => {
    process.exit(code ?? 0)
  })
} else {
  // Production mode - use compiled JavaScript
  const { compilePackage, compileUIPackage, validateTSC, performESBuild, collectFiles } = require(compileModulePath)

  const args = process.argv.slice(2)
  const cwd = process.cwd()

  async function main() {
    switch (args[0]) {
      case 'ui': {
        console.log('Nothing to compile for UI')
        break
      }

      case 'ui-esbuild': {
        console.log('Building UI package with Svelte support...')
        const st = performance.now()
        const result = await compileUIPackage(cwd)
        if (result.success) {
          console.log('UI build time:', Math.round(result.time * 100) / 100, 'ms')
        } else {
          console.error('UI build failed:', result.error)
          process.exit(1)
        }
        break
      }

      case 'transpile': {
        const srcDir = args[1] || 'src'
        const st = performance.now()
        const filesToTranspile = collectFiles(join(cwd, srcDir))

        if (filesToTranspile.length === 0) {
          console.log('No files to transpile')
          break
        }

        try {
          await performESBuild(filesToTranspile, { srcDir, cwd })
          console.log('Transpile time:', Math.round((performance.now() - st) * 100) / 100, 'ms')
        } catch (err) {
          console.error('Transpile failed:', err)
          process.exit(1)
        }
        break
      }

      case 'validate': {
        const st = performance.now()
        try {
          await validateTSC({ cwd })
          console.log('Validate time:', Math.round((performance.now() - st) * 100) / 100, 'ms')
        } catch (err) {
          console.error('Validate failed:', err)
          process.exit(1)
        }
        break
      }

      default: {
        // Full build: transpile + validate
        const st = performance.now()
        const result = await compilePackage(cwd, 'full')
        if (result.success) {
          console.log('Full build time:', Math.round(result.time * 100) / 100, 'ms')
        } else {
          console.error('Build failed:', result.error)
          process.exit(1)
        }
        break
      }
    }
  }

  main().catch((err) => {
    console.error('Unexpected error:', err)
    process.exit(1)
  })
}
