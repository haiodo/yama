import { parentPort, threadId } from 'worker_threads'
import { join, basename, dirname, relative } from 'path'
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  lstatSync,
  statSync,
  unlinkSync,
  rmSync
} from 'fs'
import crypto from 'crypto'
import * as ts from 'typescript'

/**
 * Fix source map paths when copying from .validate/emit to types
 * The emit directory is one level deeper, so sources paths need adjustment
 * e.g., "../../src/index.ts" -> "../src/index.ts"
 */
function fixSourceMapPaths (content: string): string {
  try {
    const map = JSON.parse(content)
    if (map.sources && Array.isArray(map.sources)) {
      map.sources = map.sources.map((source: string) => {
        // Replace ../../ with ../ at the beginning of the path
        // This accounts for the extra directory level in .validate/emit
        if (source.startsWith('../../')) {
          return '../' + source.slice(6)
        }
        return source
      })
      return JSON.stringify(map)
    }
    return content
  } catch {
    // If parsing fails, return original content
    return content
  }
}

// Track validation count for memory management
let validationCount = 0
const MAX_VALIDATIONS_BEFORE_CLEANUP = 10

// Cache for source file content within this worker
const sourceFileContentCache = new Map<string, string>()
// Cache for parsed SourceFile objects (much faster than re-parsing)
const sourceFileCache = new Map<string, ts.SourceFile>()

/**
 * Try to trigger garbage collection if available
 */
function tryGC (): boolean {
  if (typeof global.gc === 'function') {
    global.gc()
    return true
  }
  return false
}

/**
 * Clear caches to free memory periodically
 */
function clearCaches (): void {
  if (sourceFileContentCache.size > 200) {
    sourceFileContentCache.clear()
  }
  if (sourceFileCache.size > 500) {
    sourceFileCache.clear()
  }

  if (validationCount >= MAX_VALIDATIONS_BEFORE_CLEANUP) {
    sourceFileContentCache.clear()
    sourceFileCache.clear()
    validationCount = 0
    tryGC()
  }
}

/**
 * Get current memory usage in MB
 */
function getMemoryUsageMB (): { heapUsed: number; heapTotal: number; rss: number } {
  const usage = process.memoryUsage()
  return {
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024),
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024),
    rss: Math.round(usage.rss / 1024 / 1024)
  }
}

/**
 * Get file signature (mtime + size) for quick comparison
 * Much faster than MD5 hashing
 */
function getFileSignature (filePath: string): string | null {
  try {
    const stat = statSync(filePath)
    return `${stat.mtime.getTime()}:${stat.size}`
  } catch {
    return null
  }
}

/**
 * Calculate hash of a string
 */
function hashString (str: string): string {
  return crypto.createHash('md5').update(str).digest('hex')
}

/**
 * Collect all files recursively from a directory
 */
function collectAllFiles (dir: string, result: string[] = []): string[] {
  if (!existsSync(dir)) return result

  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectAllFiles(fullPath, result)
    } else {
      result.push(fullPath)
    }
  }
  return result
}

/**
 * Collect source files (.ts, .js, .svelte) recursively
 */
function collectSourceFiles (source: string): string[] {
  const result: string[] = []
  if (!existsSync(source)) {
    return result
  }
  const files = readdirSync(source)
  for (const f of files) {
    const sourceFile = join(source, f)

    if (lstatSync(sourceFile).isDirectory()) {
      result.push(...collectSourceFiles(sourceFile))
    } else {
      const fileName = basename(sourceFile)
      if (!fileName.endsWith('.ts') && !fileName.endsWith('.js') && !fileName.endsWith('.svelte')) {
        continue
      }
      result.push(sourceFile)
    }
  }
  return result
}

/**
 * Result of directory sync operation
 */
export interface SyncResult {
  copied: number
  unchanged: number
  removed: number
}

/**
 * Sync directory from source to destination, only copying changed files
 * Also removes files from dest that don't exist in source
 */
function syncDirectory (srcDir: string, destDir: string): SyncResult {
  let copied = 0
  let unchanged = 0
  let removed = 0

  if (!existsSync(srcDir)) {
    return { copied, unchanged, removed }
  }

  // Ensure destination exists
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true })
  }

  // Get all source files
  const srcFiles = collectAllFiles(srcDir)
  const srcRelPaths = new Set(srcFiles.map(f => relative(srcDir, f)))

  // Get all destination files
  const destFiles = collectAllFiles(destDir)
  const destRelPaths = new Map(destFiles.map(f => [relative(destDir, f), f]))

  // Copy new/changed files from source to dest
  // Use direct content comparison (faster than MD5 for small files)
  for (const srcFile of srcFiles) {
    const relPath = relative(srcDir, srcFile)
    const destFile = join(destDir, relPath)
    const isSourceMap = srcFile.endsWith('.d.ts.map')

    // Read source content, fixing source map paths if needed
    let srcContent = readFileSync(srcFile)
    if (isSourceMap) {
      const fixedContent = fixSourceMapPaths(srcContent.toString('utf-8'))
      srcContent = Buffer.from(fixedContent, 'utf-8')
    }

    // Compare content directly - TypeScript always rewrites emit files even if unchanged
    const destExists = existsSync(destFile)
    let contentsMatch = false
    if (destExists) {
      const destContent = readFileSync(destFile)
      contentsMatch = srcContent.equals(destContent)
    }

    // If content differs or dest doesn't exist, file needs to be written
    if (!contentsMatch) {
      // Create directory if needed
      const destFileDir = dirname(destFile)
      if (!existsSync(destFileDir)) {
        mkdirSync(destFileDir, { recursive: true })
      }

      writeFileSync(destFile, srcContent)
      copied++
    } else {
      unchanged++
    }
  }

  // Remove files from dest that don't exist in source
  for (const [relPath, destFile] of destRelPaths) {
    if (!srcRelPaths.has(relPath)) {
      try {
        unlinkSync(destFile)
        removed++
      } catch {
        // Ignore removal errors
      }
    }
  }

  // Clean up empty directories in dest
  cleanEmptyDirs(destDir)

  return { copied, unchanged, removed }
}

/**
 * Remove empty directories recursively
 */
function cleanEmptyDirs (dir: string): void {
  if (!existsSync(dir)) return

  const entries = readdirSync(dir, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.isDirectory()) {
      cleanEmptyDirs(join(dir, entry.name))
    }
  }

  // Re-check after cleaning subdirs
  const remaining = readdirSync(dir)
  if (remaining.length === 0) {
    try {
      rmSync(dir, { recursive: true })
    } catch {
      // Ignore
    }
  }
}

/**
 * Calculate signature for package validation state
 * Uses mtime+size instead of MD5 for speed
 * Includes: src files, tsconfig.json, package.json deps, and dependency types signatures
 */
function calculatePackageHash (cwd: string, dependencyTypesHashes: Record<string, string> = {}, srcDirName: string = 'src'): string {
  const parts: string[] = []

  // Signature of source directory content (mtime + size for each file)
  const srcDir = join(cwd, srcDirName)
  if (existsSync(srcDir)) {
    const srcFiles = collectSourceFiles(srcDir).sort()
    for (const file of srcFiles) {
      const sig = getFileSignature(file)
      if (sig) {
        parts.push(`${srcDirName}:${relative(srcDir, file)}:${sig}`)
      }
    }
  }

  // Signature of tsconfig.json
  const tsconfigPath = join(cwd, 'tsconfig.json')
  if (existsSync(tsconfigPath)) {
    const sig = getFileSignature(tsconfigPath)
    if (sig) {
      parts.push(`tsconfig:${sig}`)
    }
  }

  // Signature of package.json (for dependency changes)
  const packageJsonPath = join(cwd, 'package.json')
  if (existsSync(packageJsonPath)) {
    const sig = getFileSignature(packageJsonPath)
    if (sig) {
      parts.push(`package:${sig}`)
    }
  }

  // Include signatures of dependency types directories
  // This ensures we revalidate when dependencies change their types
  const sortedDeps = Object.keys(dependencyTypesHashes).sort()
  for (const dep of sortedDeps) {
    parts.push(`dep:${dep}:${dependencyTypesHashes[dep]}`)
  }

  // Combine all parts into a hash
  return hashString(parts.join('\n'))
}

/**
 * Calculate signature of types directory content
 * Uses mtime+size for speed instead of MD5
 */
function calculateTypesHash (typesDir: string): string {
  if (!existsSync(typesDir)) {
    return 'empty'
  }

  const files = collectAllFiles(typesDir).sort()
  const parts: string[] = []

  for (const file of files) {
    const sig = getFileSignature(file)
    if (sig) {
      parts.push(`${relative(typesDir, file)}:${sig}`)
    }
  }

  if (parts.length === 0) {
    return 'empty'
  }

  return hashString(parts.join('\n'))
}

/**
 * Validation cache state
 */
interface ValidationCache {
  packageHash?: string
  typesHash?: string
  timestamp?: number
}

/**
 * Load cached validation state
 */
function loadValidationCache (buildDir: string): ValidationCache | null {
  const cachePath = join(buildDir, 'validation-cache.json')
  try {
    if (existsSync(cachePath)) {
      return JSON.parse(readFileSync(cachePath, 'utf-8')) as ValidationCache
    }
  } catch {
    // Ignore cache read errors
  }
  return null
}

/**
 * Save validation cache state
 */
function saveValidationCache (buildDir: string, cache: ValidationCache): void {
  const cachePath = join(buildDir, 'validation-cache.json')
  try {
    writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8')
  } catch {
    // Ignore cache write errors
  }
}

/**
 * Create a compiler host with file content and SourceFile caching
 * Caching SourceFile objects is much faster than re-parsing the same files
 */
function createCachingCompilerHost (options: ts.CompilerOptions, cwd: string): ts.CompilerHost {
  const defaultHost = ts.createCompilerHost(options)

  return {
    ...defaultHost,

    readFile (fileName: string): string | undefined {
      // Only cache .d.ts files from node_modules
      if (fileName.includes('node_modules') && fileName.endsWith('.d.ts')) {
        const cached = sourceFileContentCache.get(fileName)
        if (cached !== undefined) {
          return cached
        }

        const content = ts.sys.readFile(fileName)
        if (content !== undefined) {
          sourceFileContentCache.set(fileName, content)
        }
        return content
      }

      return ts.sys.readFile(fileName)
    },

    // Cache parsed SourceFile objects for node_modules .d.ts files
    // This avoids re-parsing the same files repeatedly across packages
    getSourceFile (fileName: string, languageVersion: ts.ScriptTarget, onError?: (message: string) => void, shouldCreateNewSourceFile?: boolean): ts.SourceFile | undefined {
      // Only cache .d.ts files from node_modules (they don't change)
      if (fileName.includes('node_modules') && fileName.endsWith('.d.ts') && !shouldCreateNewSourceFile) {
        const cacheKey = `${fileName}:${languageVersion}`
        const cached = sourceFileCache.get(cacheKey)
        if (cached) {
          return cached
        }

        const sourceFile = defaultHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
        if (sourceFile) {
          sourceFileCache.set(cacheKey, sourceFile)
        }
        return sourceFile
      }

      return defaultHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
    },

    getCurrentDirectory (): string {
      return cwd
    },

    fileExists (fileName: string): boolean {
      return ts.sys.fileExists(fileName)
    },

    getDirectories (path: string): string[] {
      return ts.sys.getDirectories(path)
    },

    directoryExists (directoryName: string): boolean {
      return ts.sys.directoryExists(directoryName)
    },

    realpath (path: string): string {
      return ts.sys.realpath ? ts.sys.realpath(path) : path
    }
  }
}

/**
 * Result of TypeScript validation
 */
export interface ValidateResult {
  skipped?: boolean
  fromCache?: boolean
  syncResult?: SyncResult
}

/**
 * Validate TypeScript in a package directory
 * @param cwd - Package directory
 * @param options - Options including dependency type hashes
 */
export function validateTSC (cwd: string, options: { dependencyTypesHashes?: Record<string, string>; srcDir?: string } = {}): ValidateResult {
  const { dependencyTypesHashes = {}, srcDir = 'src' } = options

  const buildDir = join(cwd, '.validate')
  const emitDir = join(buildDir, 'emit')
  const typesDir = join(cwd, 'types')

  if (!existsSync(buildDir)) {
    mkdirSync(buildDir, { recursive: true })
  }

  // Calculate current package hash
  const currentHash = calculatePackageHash(cwd, dependencyTypesHashes, srcDir)

  // Load cached state
  const cachedState = loadValidationCache(buildDir)

  // Check if we can use cached emit
  if (cachedState && cachedState.packageHash === currentHash && existsSync(emitDir)) {
    // Hash matches! Just sync emit dir to types dir
    const syncResult = syncDirectory(emitDir, typesDir)

    // Calculate and save types hash
    const typesHash = calculateTypesHash(typesDir)
    saveValidationCache(buildDir, {
      ...cachedState,
      typesHash
    })

    return {
      skipped: true,
      fromCache: true,
      syncResult
    }
  }

  // Create emit directory
  if (!existsSync(emitDir)) {
    mkdirSync(emitDir, { recursive: true })
  }

  const stdoutFilePath = join(buildDir, 'validate.log')
  const stderrFilePath = join(buildDir, 'validate-err.log')

  // Read tsconfig.json
  const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, 'tsconfig.json')

  if (!configPath) {
    throw new Error('Could not find tsconfig.json')
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)

  // Prepare compiler options with performance optimizations
  const compilerOptionsOverride: ts.CompilerOptions = {
    emitDeclarationOnly: true,
    declaration: true,
    declarationDir: emitDir,  // Emit to temp directory
    incremental: true,
    tsBuildInfoFile: join(buildDir, 'tsBuildInfoFile.info'),
    skipLibCheck: true,              // Skip type checking of .d.ts files
    skipDefaultLibCheck: true,       // Skip type checking of default lib (lib.d.ts)
    noLib: false,
    // Performance: disable searching for other tsconfig/project files
    disableSolutionSearching: true,
    disableReferencedProjectLoad: true
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    cwd,
    compilerOptionsOverride
  )

  // Add generated Svelte type files to the file list
  if (existsSync(typesDir)) {
    const svelteTypeFiles = collectSourceFiles(typesDir).filter((f) => f.endsWith('.svelte.d.ts'))
    parsedConfig.fileNames.push(...svelteTypeFiles)
  }

  // Create caching compiler host
  const host = createCachingCompilerHost(parsedConfig.options, cwd)

  // Create the TypeScript program
  let program: ts.Program | null = ts.createProgram({
    rootNames: parsedConfig.fileNames,
    options: parsedConfig.options,
    host
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

  const hasErrors = allDiagnostics.length > 0
  const emitSkipped = emitResult.emitSkipped

  // Release TypeScript program
  program = null

  // Increment validation count and clean up periodically
  validationCount++
  clearCaches()

  if (hasErrors) {
    throw new Error(stderr.join('\n'))
  }

  if (emitSkipped) {
    throw new Error('TypeScript emit was skipped')
  }

  // Sync emit directory to types directory
  const syncResult = syncDirectory(emitDir, typesDir)

  // Calculate and save types hash
  const typesHash = calculateTypesHash(typesDir)

  // Save cache state
  saveValidationCache(buildDir, {
    packageHash: currentHash,
    typesHash,
    timestamp: Date.now()
  })

  return {
    skipped: false,
    fromCache: false,
    syncResult
  }
}

/**
 * Worker task types
 */
interface WorkerTask {
  id: number
  type: 'validate' | 'get-types-hash' | 'gc' | 'clear-cache' | 'exit'
  cwd?: string
  reportMemory?: boolean
  dependencyTypesHashes?: Record<string, string>
  srcDir?: string
}

interface WorkerResult {
  id: number
  success?: boolean
  error?: string
  skipped?: boolean
  fromCache?: boolean
  syncResult?: SyncResult
  typesHash?: string
  memory?: {
    before?: { heapUsed: number; heapTotal: number; rss: number }
    after?: { heapUsed: number; heapTotal: number; rss: number }
  }
  threadId?: number
  cacheStats?: {
    sourceFiles: number
  }
  gcRan?: boolean
}

// Worker message handler
if (parentPort) {
  parentPort.on('message', (task: WorkerTask) => {
    const { id, type, cwd, reportMemory, dependencyTypesHashes, srcDir = 'src' } = task

    if (type === 'validate' && cwd) {
      try {
        const startMem = reportMemory ? getMemoryUsageMB() : undefined
        const result = validateTSC(cwd, { dependencyTypesHashes: dependencyTypesHashes || {}, srcDir })
        const endMem = reportMemory ? getMemoryUsageMB() : undefined

        // Calculate types hash for this package (to be used by dependents)
        const typesDir = join(cwd, 'types')
        const typesHash = calculateTypesHash(typesDir)

        const workerResult: WorkerResult = {
          id,
          success: true,
          skipped: result?.skipped || false,
          fromCache: result?.fromCache || false,
          syncResult: result?.syncResult,
          typesHash,
          memory: reportMemory ? { before: startMem, after: endMem } : undefined,
          threadId,
          cacheStats: {
            sourceFiles: sourceFileContentCache.size
          }
        }
        parentPort!.postMessage(workerResult)
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        parentPort!.postMessage({ id, success: false, error: errorMessage, threadId } as WorkerResult)
      }
    } else if (type === 'get-types-hash' && cwd) {
      // Get types hash for a package without validation
      try {
        const typesDir = join(cwd, 'types')
        const typesHash = calculateTypesHash(typesDir)
        parentPort!.postMessage({ id, typesHash, threadId } as WorkerResult)
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        parentPort!.postMessage({ id, typesHash: 'error', error: errorMessage, threadId } as WorkerResult)
      }
    } else if (type === 'gc') {
      clearCaches()
      const gcRan = tryGC()
      const mem = getMemoryUsageMB()
      parentPort!.postMessage({ id, type: 'gc-result', gcRan, memory: mem, threadId } as WorkerResult)
    } else if (type === 'clear-cache') {
      sourceFileContentCache.clear()
      tryGC()
      const mem = getMemoryUsageMB()
      parentPort!.postMessage({ id, type: 'cache-cleared', memory: mem, threadId } as WorkerResult)
    } else if (type === 'exit') {
      process.exit(0)
    }
  })

  // Signal ready with initial memory info
  const initialMem = getMemoryUsageMB()
  parentPort.postMessage({
    type: 'ready',
    threadId,
    memory: initialMem,
    gcAvailable: typeof global.gc === 'function'
  })
}

// Export for direct usage
export {
  calculateTypesHash,
  calculatePackageHash,
  syncDirectory,
  getMemoryUsageMB,
  tryGC
}
