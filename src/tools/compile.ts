import { join, dirname, basename, relative } from 'path'
import {
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  writeFileSync,
  copyFileSync
} from 'fs'
import * as esbuild from 'esbuild'
import { copy } from 'esbuild-plugin-copy'
import * as ts from 'typescript'

/**
 * Options for ESBuild operations
 */
export interface ESBuildOptions {
  /** Source directory for JSON assets */
  srcDir?: string
  /** Working directory (defaults to process.cwd()) */
  cwd?: string
  /** Output directory */
  outDir?: string
}

/**
 * Options for TypeScript validation
 */
export interface ValidateOptions {
  /** Working directory (defaults to process.cwd()) */
  cwd?: string
  /** Throw error instead of process.exit */
  throwOnError?: boolean
}

/**
 * Collect source files recursively from a directory
 * @param source - Source directory path
 * @returns Array of file paths
 */
export function collectFiles (source: string): string[] {
  const result: string[] = []
  if (!existsSync(source)) {
    return result
  }
  const files = readdirSync(source)
  for (const f of files) {
    const sourceFile = join(source, f)

    if (lstatSync(sourceFile).isDirectory()) {
      result.push(...collectFiles(sourceFile))
    } else {
      const fileName = basename(sourceFile)
      // Skip non-source files
      if (!fileName.endsWith('.ts') && !fileName.endsWith('.js') && !fileName.endsWith('.svelte')) {
        continue
      }
      result.push(sourceFile)
    }
  }
  return result
}

/**
 * Collect file modification times from a directory
 * @param source - Source directory path
 * @param result - Object to store file paths and their mtimes
 */
export function collectFileStats (source: string, result: Record<string, number>): void {
  if (!existsSync(source)) {
    return
  }
  const files = readdirSync(source)
  for (const f of files) {
    const sourceFile = join(source, f)
    const stat = lstatSync(sourceFile)
    if (stat.isDirectory()) {
      collectFileStats(sourceFile, result)
    } else {
      const ext = basename(sourceFile)
      if (!ext.endsWith('.ts') && !ext.endsWith('.js') && !ext.endsWith('.svelte')) {
        continue
      }
      result[sourceFile] = stat.mtime.getTime()
    }
  }
}

/**
 * Collect JSON files recursively from a directory
 * @param source - Source directory path
 * @returns Array of JSON file paths
 */
export function collectJsonFiles (source: string): string[] {
  const result: string[] = []
  if (!existsSync(source)) {
    return result
  }
  const files = readdirSync(source)
  for (const f of files) {
    const sourceFile = join(source, f)
    if (lstatSync(sourceFile).isDirectory()) {
      result.push(...collectJsonFiles(sourceFile))
    } else if (f.endsWith('.json')) {
      result.push(sourceFile)
    }
  }
  return result
}

/**
 * Copy JSON files from source to destination preserving directory structure
 * @param srcDir - Source directory (relative to cwd)
 * @param outDir - Output directory (relative to cwd)
 * @param cwd - Working directory
 */
export function copyJsonFiles (srcDir: string, outDir: string, cwd: string): void {
  const absoluteSrcDir = join(cwd, srcDir)
  const absoluteOutDir = join(cwd, outDir)
  const jsonFiles = collectJsonFiles(absoluteSrcDir)

  for (const jsonFile of jsonFiles) {
    const relativePath = relative(absoluteSrcDir, jsonFile)
    const destFile = join(absoluteOutDir, relativePath)
    const destDir = dirname(destFile)

    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true })
    }
    copyFileSync(jsonFile, destFile)
  }
}

/**
 * Transpile TypeScript/JavaScript files using esbuild
 * @param filesToTranspile - Array of file paths to transpile
 * @param options - Options object
 */
export async function performESBuild (
  filesToTranspile: string[],
  options: ESBuildOptions = {}
): Promise<void> {
  const {
    srcDir = 'src',
    cwd = process.cwd(),
    outDir = 'lib'
  } = options

  if (filesToTranspile.length === 0) {
    return
  }

  // Copy JSON files manually (esbuild-plugin-copy doesn't work well with absWorkingDir)
  copyJsonFiles(srcDir, outDir, cwd)

  await esbuild.build({
    entryPoints: filesToTranspile,
    bundle: false,
    minify: false,
    outdir: outDir,
    keepNames: true,
    sourcemap: 'linked',
    allowOverwrite: true,
    format: 'cjs',
    color: true,
    absWorkingDir: cwd
  })
}

/**
 * Transpile files with Svelte support using esbuild
 * @param filesToTranspile - Array of file paths to transpile
 * @param options - Options object
 */
export async function performESBuildWithSvelte (
  filesToTranspile: string[],
  options: ESBuildOptions = {}
): Promise<void> {
  const { cwd = process.cwd() } = options

  // Separate Svelte and non-Svelte files
  const svelteFiles = filesToTranspile.filter((f) => f.endsWith('.svelte'))
  const nonSvelteFiles = filesToTranspile.filter((f) => !f.endsWith('.svelte'))

  const outdir = join(cwd, 'lib')
  const outbase = join(cwd, 'src')

  // Build non-Svelte files
  if (nonSvelteFiles.length > 0) {
    await esbuild.build({
      entryPoints: nonSvelteFiles,
      bundle: false,
      minify: false,
      outdir,
      outbase,
      keepNames: true,
      logLevel: 'error',
      sourcemap: 'linked',
      allowOverwrite: true,
      format: 'cjs',
      color: true,
      absWorkingDir: cwd,
      plugins: [
        copy({
          resolveFrom: 'cwd',
          assets: {
            from: [join(cwd, 'src/**/*.json')],
            to: [outdir]
          },
          watch: false
        })
      ]
    })
  }

  // Build Svelte files
  if (svelteFiles.length > 0) {
    // Dynamic import for esbuild-svelte to avoid dependency issues
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sveltePlugin = require('esbuild-svelte')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sveltePreprocess = require('svelte-preprocess')

    await esbuild.build({
      entryPoints: svelteFiles,
      bundle: false,
      minify: false,
      outdir,
      outbase,
      outExtension: { '.js': '.svelte.js' },
      keepNames: true,
      sourcemap: 'linked',
      logLevel: 'error',
      allowOverwrite: true,
      format: 'cjs',
      color: true,
      absWorkingDir: cwd,
      plugins: [
        sveltePlugin({
          preprocess: sveltePreprocess(),
          compilerOptions: {
            css: 'injected',
            generate: 'ssr'
          }
        })
      ]
    })
  }
}

/**
 * Generate TypeScript declaration files for Svelte components
 * @param options - Options object
 */
export async function generateSvelteTypes (options: ESBuildOptions = {}): Promise<void> {
  const { cwd = process.cwd() } = options
  const srcDir = join(cwd, 'src')
  const typesDir = join(cwd, 'types')

  if (!existsSync(srcDir)) {
    return
  }

  if (!existsSync(typesDir)) {
    mkdirSync(typesDir, { recursive: true })
  }

  const svelteFiles = collectFiles(srcDir).filter((f) => f.endsWith('.svelte'))

  // Dynamic import for svelte2tsx
  const { svelte2tsx } = await import('svelte2tsx')

  for (const svelteFile of svelteFiles) {
    try {
      const content = readFileSync(svelteFile, 'utf-8')
      svelte2tsx(content, {
        filename: svelteFile,
        isTsFile: true,
        mode: 'dts'
      })

      const relativePath = svelteFile.replace(srcDir, '')
      const outputPath = join(typesDir, relativePath.replace('.svelte', '.svelte.d.ts'))
      const outputDir = dirname(outputPath)

      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true })
      }

      // Generate simple .d.ts file for Svelte components
      const dtsContent = 'import { SvelteComponentTyped } from \'svelte\';\nexport default class extends SvelteComponentTyped<any, any, any> {}\n'
      writeFileSync(outputPath, dtsContent)
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.error(`Error generating types for ${svelteFile}:`, errorMessage)
    }
  }
}

/**
 * Validate TypeScript and emit declaration files
 * @param options - Options object
 */
export async function validateTSC (options: ValidateOptions = {}): Promise<void> {
  const { cwd = process.cwd(), throwOnError = false } = options
  const buildDir = join(cwd, '.validate')
  const typesDir = join(cwd, 'types')

  if (!existsSync(buildDir)) {
    mkdirSync(buildDir, { recursive: true })
  }

  const stdoutFilePath = join(buildDir, 'validate.log')
  const stderrFilePath = join(buildDir, 'validate-err.log')

  // Read tsconfig.json
  const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, 'tsconfig.json')

  if (!configPath) {
    const err = new Error('Could not find tsconfig.json')
    if (throwOnError) {
      throw err
    }
    console.error(err.message)
    process.exit(1)
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)

  // Prepare compiler options
  // Note: We don't add typesDir to typeRoots because typeRoots expects directories
  // containing type packages (like @types/node), not arbitrary .d.ts files.
  // Subdirectories in typesDir (like __test__, main) would be treated as type packages,
  // causing errors like "Cannot find type definition file for '__test__'"
  const compilerOptionsOverride: ts.CompilerOptions = {
    emitDeclarationOnly: true,
    declaration: true,
    declarationDir: typesDir,  // Always emit to types directory
    incremental: true,
    tsBuildInfoFile: join(buildDir, 'tsBuildInfoFile.info'),
    skipLibCheck: true,
    noLib: false
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    cwd,
    compilerOptionsOverride
  )

  // Add generated Svelte type files to the file list
  if (existsSync(typesDir)) {
    const svelteTypeFiles = collectFiles(typesDir).filter((f) => f.endsWith('.svelte.d.ts'))
    parsedConfig.fileNames.push(...svelteTypeFiles)
  }

  // Create the TypeScript program
  const program = ts.createProgram({
    rootNames: parsedConfig.fileNames,
    options: parsedConfig.options
  })

  // Get diagnostics
  const emitResult = program.emit()
  const allDiagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics)

  const stdout: string[] = []
  const stderr: string[] = []

  // Format diagnostics
  allDiagnostics.forEach((diagnostic) => {
    if (diagnostic.file && diagnostic.start !== undefined) {
      const { line, character } = ts.getLineAndCharacterOfPosition(diagnostic.file, diagnostic.start)
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
      const output = `${diagnostic.file.fileName}(${line + 1},${character + 1}): error TS${diagnostic.code}: ${message}`
      stderr.push(output)
    } else {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
      stderr.push(`error TS${diagnostic.code}: ${message}`)
    }
  })

  // Write logs
  writeFileSync(stdoutFilePath, stdout.join('\n'))
  writeFileSync(stderrFilePath, stderr.join('\n'))

  if (allDiagnostics.length > 0) {
    const errorMessage = stderr.join('\n')
    if (throwOnError) {
      throw new Error(errorMessage)
    }
    console.error('\n' + errorMessage)
    process.exit(1)
  }

  if (emitResult.emitSkipped) {
    const err = new Error('TypeScript emit was skipped')
    if (throwOnError) {
      throw err
    }
    process.exit(1)
  }
}

/**
 * Compile a single package
 * @param cwd - Package directory
 * @param mode - Compilation mode ('transpile', 'validate', or 'full')
 * @param srcDir - Source directory name
 */
export async function compilePackage (
  cwd: string,
  mode: 'transpile' | 'validate' | 'full' = 'full',
  srcDir: string = 'src'
): Promise<{ success: boolean; error?: Error; time: number }> {
  const st = performance.now()

  try {
    if (mode === 'transpile' || mode === 'full') {
      const filesToTranspile = collectFiles(join(cwd, srcDir))
      if (filesToTranspile.length > 0) {
        await performESBuild(filesToTranspile, { srcDir, cwd, outDir: 'lib' })
      }
    }

    if (mode === 'validate' || mode === 'full') {
      await validateTSC({ cwd, throwOnError: true })
    }

    return { success: true, time: performance.now() - st }
  } catch (err: unknown) {
    return {
      success: false,
      error: err instanceof Error ? err : new Error(String(err)),
      time: performance.now() - st
    }
  }
}

/**
 * Compile a UI package with Svelte support
 * @param cwd - Package directory
 */
export async function compileUIPackage (
  cwd: string
): Promise<{ success: boolean; error?: Error; time: number }> {
  const st = performance.now()

  try {
    const filesToTranspile = collectFiles(join(cwd, 'src'))
    await performESBuildWithSvelte(filesToTranspile, { cwd })
    await generateSvelteTypes({ cwd })
    return { success: true, time: performance.now() - st }
  } catch (err: unknown) {
    return {
      success: false,
      error: err instanceof Error ? err : new Error(String(err)),
      time: performance.now() - st
    }
  }
}
