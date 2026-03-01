import { execSync } from 'child_process'
import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import os from 'os'
import { Worker } from 'worker_threads'
import type { PackageInfo } from './types.js'

// Import compile functions
import { collectFiles, performESBuild, performESBuildWithSvelte, generateSvelteTypes } from './compile.js'

/**
 * CPU usage tracking
 */
let lastCpuInfo: { user: number; nice: number; sys: number; idle: number; irq: number; total: number } | null = null

function getCpuTimes (): { user: number; nice: number; sys: number; idle: number; irq: number; total: number } {
  const cpus = os.cpus()
  let user = 0; let nice = 0; let sys = 0; let idle = 0; let irq = 0
  for (const cpu of cpus) {
    user += cpu.times.user
    nice += cpu.times.nice
    sys += cpu.times.sys
    idle += cpu.times.idle
    irq += cpu.times.irq
  }
  return { user, nice, sys, idle, irq, total: user + nice + sys + idle + irq }
}

function startCpuTracking (): typeof lastCpuInfo {
  lastCpuInfo = getCpuTimes()
  return lastCpuInfo
}

function getCpuUsage (): { percent: number; user: number; sys: number } {
  if (!lastCpuInfo) {
    lastCpuInfo = getCpuTimes()
    return { percent: 0, user: 0, sys: 0 }
  }

  const current = getCpuTimes()
  const diff = {
    user: current.user - lastCpuInfo.user,
    nice: current.nice - lastCpuInfo.nice,
    sys: current.sys - lastCpuInfo.sys,
    idle: current.idle - lastCpuInfo.idle,
    total: current.total - lastCpuInfo.total
  }

  const percent = diff.total > 0 ? ((diff.user + diff.nice + diff.sys) / diff.total) * 100 : 0
  const userPercent = diff.total > 0 ? (diff.user / diff.total) * 100 : 0
  const sysPercent = diff.total > 0 ? (diff.sys / diff.total) * 100 : 0

  lastCpuInfo = current
  return { percent, user: userPercent, sys: sysPercent }
}

/**
 * Track CPU usage over time
 */
class CpuTracker {
  private intervalMs: number
  private samples: Array<{ percent: number; user: number; sys: number }> = []
  private interval: ReturnType<typeof setInterval> | null = null
  private peakPercent = 0

  constructor (intervalMs: number = 100) {
    this.intervalMs = intervalMs
  }

  start (): void {
    startCpuTracking()
    this.samples = []
    this.peakPercent = 0
    this.interval = setInterval(() => {
      const usage = getCpuUsage()
      this.samples.push(usage)
      if (usage.percent > this.peakPercent) {
        this.peakPercent = usage.percent
      }
    }, this.intervalMs)
  }

  stop (): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
    // Get final sample
    const usage = getCpuUsage()
    this.samples.push(usage)
    if (usage.percent > this.peakPercent) {
      this.peakPercent = usage.percent
    }
  }

  getStats (): { avg: number; peak: number; min: number; samples: number } {
    if (this.samples.length === 0) {
      return { avg: 0, peak: 0, min: 0, samples: 0 }
    }

    const percents = this.samples.map(s => s.percent)
    const avg = percents.reduce((a, b) => a + b, 0) / percents.length
    const peak = Math.max(...percents)
    const min = Math.min(...percents)

    return {
      avg: Math.round(avg * 10) / 10,
      peak: Math.round(peak * 10) / 10,
      min: Math.round(min * 10) / 10,
      samples: this.samples.length
    }
  }
}

/**
 * Get available system memory in MB
 */
function getAvailableMemoryMB (): number {
  const freeMem = os.freemem()

  // On macOS/Linux, try to get more accurate available memory
  try {
    if (process.platform === 'darwin') {
      // macOS: use vm_stat
      const vmstat = execSync('vm_stat', { encoding: 'utf-8' })
      const pageSize = 4096
      const freeMatch = vmstat.match(/Pages free:\s+(\d+)/)
      const inactiveMatch = vmstat.match(/Pages inactive:\s+(\d+)/)
      if (freeMatch && inactiveMatch) {
        const freePages = parseInt(freeMatch[1], 10)
        const inactivePages = parseInt(inactiveMatch[1], 10)
        return Math.round((freePages + inactivePages) * pageSize / 1024 / 1024)
      }
    } else if (process.platform === 'linux') {
      // Linux: use /proc/meminfo
      const meminfo = readFileSync('/proc/meminfo', 'utf-8')
      const availableMatch = meminfo.match(/MemAvailable:\s+(\d+)/)
      if (availableMatch) {
        return Math.round(parseInt(availableMatch[1], 10) / 1024)
      }
    }
  } catch {
    // Fall back to simple calculation
  }

  return Math.round(freeMem / 1024 / 1024)
}

/**
 * Determine optimal worker count based on available memory
 * Each TypeScript worker uses approximately 1.5-2.5 GB of memory
 */
function getOptimalWorkerCount (requestedWorkers: number): { workers: number; availableMemoryMB: number; limitedByMemory: boolean } {
  const availableMem = getAvailableMemoryMB()
  const cpuCount = os.cpus().length

  // Estimate memory per worker for TypeScript validation
  // macOS reports available memory conservatively, so use lower estimate
  const memoryPerWorker = process.platform === 'darwin' ? 1500 : 2500
  const maxWorkersByMemory = Math.max(1, Math.floor(availableMem / memoryPerWorker))

  // Use the minimum of requested, CPU count, and memory-based limit
  const optimal = Math.min(requestedWorkers, cpuCount, maxWorkersByMemory)

  return {
    workers: optimal,
    availableMemoryMB: availableMem,
    limitedByMemory: optimal < requestedWorkers && maxWorkersByMemory < requestedWorkers
  }
}

/**
 * Clean a directory (remove it completely)
 */
function cleanDirectory (dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Worker task interface
 */
interface WorkerTask {
  id: number
  type: 'validate' | 'get-types-hash' | 'gc' | 'exit'
  cwd?: string
  reportMemory?: boolean
  dependencyTypesHashes?: Record<string, string>
  srcDir?: string
}

/**
 * Memory info structure
 */
interface MemoryInfo {
  rss: number
  heapUsed?: number
  heapTotal?: number
}

/**
 * Memory comparison structure
 */
interface MemoryComparison {
  before?: MemoryInfo
  after?: MemoryInfo
}

/**
 * Worker result interface
 */
interface WorkerResult {
  id?: number
  success?: boolean
  error?: string
  skipped?: boolean
  fromCache?: boolean
  typesHash?: string
  syncResult?: { copied: number; unchanged: number; removed: number }
  memory?: MemoryInfo | MemoryComparison
  threadId?: number
  gcRan?: boolean
  cacheStats?: { sourceFiles: number }
  type?: string
}

/**
 * Worker pool for parallel TypeScript validation
 */
class ValidateWorkerPool {
  private size: number
  private workers: Array<Worker & { _workerId?: number }> = []
  private available: Array<Worker & { _workerId?: number }> = []
  private pending: Array<{
    task: WorkerTask
    resolve: (value: WorkerResult) => void
  }> = []

  private taskId = 0
  private callbacks = new Map<number, (result: WorkerResult) => void>()
  private workerPath: string
  private gcAvailable = false
  private workerMemory = new Map<number, MemoryInfo>()
  // Worker timing tracking
  private workerStats = new Map<number, { totalIdleTime: number; totalWorkTime: number; taskCount: number; lastTaskCompletedAt: number | null }>()
  private taskTimings = new Map<number, { startedAt: number; workerId: number }>()

  constructor (size: number) {
    this.size = size
    this.workerPath = join(__dirname, 'validate-worker.js')
  }

  async init (): Promise<void> {
    const readyPromises: Promise<void>[] = []

    for (let i = 0; i < this.size; i++) {
      // Spawn worker - GC is available if main process was started with --expose-gc
      const worker = new Worker(this.workerPath) as Worker & { _workerId?: number }
      worker._workerId = i // Track worker id
      this.workers.push(worker)
      // Initialize worker stats - lastTaskCompletedAt starts at init time (worker ready)
      this.workerStats.set(i, { totalIdleTime: 0, totalWorkTime: 0, taskCount: 0, lastTaskCompletedAt: null })

      const readyPromise = new Promise<void>((resolve) => {
        const onMessage = (msg: { type: string; gcAvailable?: boolean; memory?: { rss: number }; threadId?: number }): void => {
          if (msg.type === 'ready') {
            worker.off('message', onMessage)
            // Track if GC is available in workers
            if (msg.gcAvailable) {
              this.gcAvailable = true
            }
            if (msg.memory) {
              this.workerMemory.set(i, msg.memory)
            }
            resolve()
          }
        }
        worker.on('message', onMessage)
      })
      readyPromises.push(readyPromise)

      worker.on('message', (msg: WorkerResult) => {
        if (msg.id !== undefined) {
          const callback = this.callbacks.get(msg.id)
          if (callback) {
            this.callbacks.delete(msg.id)
            callback(msg)
          }
          // Track timing stats
          const timing = this.taskTimings.get(msg.id)
          if (timing) {
            const completedAt = performance.now()
            const workTime = completedAt - timing.startedAt
            const stats = this.workerStats.get(timing.workerId)
            if (stats) {
              stats.totalWorkTime += workTime
              stats.taskCount++
              stats.lastTaskCompletedAt = completedAt
            }
            this.taskTimings.delete(msg.id)
          }
          // Track memory usage from worker
          if (msg.memory && msg.threadId !== undefined) {
            const memData = msg.memory
            // Check if it's a MemoryComparison (has after property) or MemoryInfo (has rss)
            if ('after' in memData && memData.after) {
              this.workerMemory.set(msg.threadId, memData.after)
            } else if ('rss' in memData && typeof memData.rss === 'number') {
              this.workerMemory.set(msg.threadId, memData as MemoryInfo)
            }
          }
          this.available.push(worker)
          this._processNext()
        }
      })

      worker.on('error', (err: Error) => {
        console.error('Worker error:', err)
      })
    }

    await Promise.all(readyPromises)
    this.available = [...this.workers]
  }

  private _processNext (): void {
    if (this.pending.length > 0 && this.available.length > 0) {
      const { task, resolve } = this.pending.shift()!
      const worker = this.available.shift()!
      const workerId = worker._workerId!
      const startedAt = performance.now()

      // Track idle time (time since worker completed last task until now)
      const stats = this.workerStats.get(workerId)
      if (stats && stats.lastTaskCompletedAt !== null) {
        const idleTime = startedAt - stats.lastTaskCompletedAt
        stats.totalIdleTime += idleTime
      }

      // Store timing info for completion tracking
      this.taskTimings.set(task.id, { startedAt, workerId })

      this.callbacks.set(task.id, (result: WorkerResult | PromiseLike<WorkerResult>) => {
        if ('then' in result) {
          // It's a PromiseLike, shouldn't happen but handle gracefully
          resolve(result as WorkerResult)
          return
        }
        const r = result as WorkerResult
        if (r.success) {
          resolve({
            id: r.id,
            success: true,
            skipped: r.skipped || false,
            fromCache: r.fromCache || false,
            typesHash: r.typesHash,
            syncResult: r.syncResult
          })
        } else {
          resolve({ id: r.id, success: false, error: r.error })
        }
      })

      worker.postMessage(task)
    }
  }

  validate (cwd: string, options: { reportMemory?: boolean; dependencyTypesHashes?: Record<string, string>; srcDir?: string } = {}): Promise<WorkerResult> {
    const { reportMemory = false, dependencyTypesHashes = {}, srcDir = 'src' } = options
    return new Promise<WorkerResult>((resolve) => {
      const task: WorkerTask = {
        id: ++this.taskId,
        type: 'validate',
        cwd,
        reportMemory,
        dependencyTypesHashes,
        srcDir
      }

      this.pending.push({ task, resolve })
      this._processNext()
    })
  }

  /**
   * Get types hash for a package without validation
   */
  getTypesHash (cwd: string): Promise<string> {
    return new Promise<string>((resolve) => {
      const task: WorkerTask = {
        id: ++this.taskId,
        type: 'get-types-hash',
        cwd
      }

      // Need to handle this differently since it's not in the normal flow
      const worker = this.available.shift()
      if (!worker) {
        // Queue it like normal
        this.pending.push({
          task,
          resolve: (result: WorkerResult) => resolve(result.typesHash || 'unknown')
        })
        return
      }

      this.callbacks.set(task.id, (result: WorkerResult) => {
        this.available.push(worker)
        this._processNext()
        resolve(result.typesHash || 'unknown')
      })

      worker.postMessage(task)
    })
  }

  /**
   * Request GC on all workers (if available)
   */
  async requestGC (): Promise<boolean> {
    if (!this.gcAvailable) return false

    const gcPromises = this.workers.map((worker, idx) => {
      return new Promise<boolean>((resolve) => {
        const id = ++this.taskId
        const timeout = setTimeout(() => resolve(false), 1000)

        this.callbacks.set(id, (msg: WorkerResult) => {
          clearTimeout(timeout)
          if (msg.memory && 'rss' in msg.memory && typeof msg.memory.rss === 'number') {
            this.workerMemory.set(idx, msg.memory as MemoryInfo)
          }
          resolve(msg.gcRan || false)
        })

        worker.postMessage({ id, type: 'gc' } as WorkerTask)
      })
    })

    await Promise.all(gcPromises)
    return true
  }

  /**
   * Get total memory usage across all workers
   */
  getTotalMemoryMB (): number {
    let total = 0
    for (const mem of this.workerMemory.values()) {
      total += mem.rss || mem.heapUsed || 0
    }
    return total
  }

  /**
   * Get timing statistics for all workers
   */
  getTimingStats (): {
    perWorker: Array<{ workerId: number; idleTime: number; workTime: number; taskCount: number; utilization: number }>
    totalIdleTime: number
    totalWorkTime: number
    totalTasks: number
    avgIdleTimePerTask: number
    avgWorkTimePerTask: number
    overallUtilization: number
  } {
    const perWorker: Array<{ workerId: number; idleTime: number; workTime: number; taskCount: number; utilization: number }> = []
    let totalIdleTime = 0
    let totalWorkTime = 0
    let totalTasks = 0

    for (const [workerId, stats] of this.workerStats) {
      const utilization = stats.totalWorkTime > 0
        ? (stats.totalWorkTime / (stats.totalIdleTime + stats.totalWorkTime)) * 100
        : 0
      perWorker.push({
        workerId,
        idleTime: stats.totalIdleTime,
        workTime: stats.totalWorkTime,
        taskCount: stats.taskCount,
        utilization
      })
      totalIdleTime += stats.totalIdleTime
      totalWorkTime += stats.totalWorkTime
      totalTasks += stats.taskCount
    }

    return {
      perWorker,
      totalIdleTime,
      totalWorkTime,
      totalTasks,
      avgIdleTimePerTask: totalTasks > 0 ? totalIdleTime / totalTasks : 0,
      avgWorkTimePerTask: totalTasks > 0 ? totalWorkTime / totalTasks : 0,
      overallUtilization: totalWorkTime > 0 ? (totalWorkTime / (totalIdleTime + totalWorkTime)) * 100 : 0
    }
  }

  async terminate (): Promise<void> {
    for (const worker of this.workers) {
      worker.postMessage({ type: 'exit' } as WorkerTask)
    }
    await Promise.all(this.workers.map(w => w.terminate()))
    this.workers = []
    this.available = []
  }
}

// Global worker pool (initialized lazily)
let workerPool: ValidateWorkerPool | null = null

async function getWorkerPool (size: number): Promise<ValidateWorkerPool> {
  if (!workerPool) {
    workerPool = new ValidateWorkerPool(size)
    await workerPool.init()
  }
  return workerPool
}

/**
 * Package node in dependency graph
 */
interface PackageNode {
  package: PackageInfo
  dependencies: Set<string>
  dependents: Set<string>
  phaseBuild: string | null
  phaseValidate: string | null
}

/**
 * Build dependency graph for all projects
 */
async function buildDependencyGraph (packages: PackageInfo[]): Promise<Map<string, PackageNode>> {
  const graph = new Map<string, PackageNode>()

  // Initialize all nodes
  for (const pkg of packages) {
    const allDeps: Record<string, string> = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies
    }

    const dependencies = Object.keys(allDeps).filter(dep => {
      const version = allDeps[dep]
      // workspace: dependencies are local packages
      return version && (version.startsWith('workspace:') || version.startsWith('link:'))
    })

    // Read package.json for phase scripts
    const packageJsonPath = join(pkg.dir, 'package.json')
    let phaseBuild: string | null = null
    let phaseValidate: string | null = null

    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
      phaseBuild = packageJson.scripts?.['_phase:build'] || null
      phaseValidate = packageJson.scripts?.['_phase:validate'] || null
    } catch {
      // Ignore errors
    }

    graph.set(pkg.name, {
      package: pkg,
      dependencies: new Set(dependencies),
      dependents: new Set(),
      phaseBuild,
      phaseValidate
    })
  }

  // Build dependents
  for (const [name, node] of graph) {
    for (const dep of node.dependencies) {
      if (graph.has(dep)) {
        graph.get(dep)!.dependents.add(name)
      }
    }
  }

  return graph
}

/**
 * Get all dependencies of a package (transitive closure)
 */
function getAllDependencies (graph: Map<string, PackageNode>, packageName: string): Set<string> {
  const result = new Set<string>()
  const visited = new Set<string>()
  const stack = [packageName]

  while (stack.length > 0) {
    const current = stack.pop()!
    if (visited.has(current)) continue
    visited.add(current)

    const node = graph.get(current)
    if (!node) continue

    for (const dep of node.dependencies) {
      result.add(dep)
      if (!visited.has(dep)) {
        stack.push(dep)
      }
    }
  }

  return result
}

/**
 * Topological sort using Kahn's algorithm
 * Returns array of "waves" - each wave contains packages that can be built in parallel
 */
function topologicalSortWaves (
  graph: Map<string, PackageNode>,
  filterFn: (node: PackageNode, name: string) => boolean
): PackageInfo[][] {
  // Filter to only packages we want to compile
  const filteredNames = new Set<string>()
  for (const [name, node] of graph) {
    if (filterFn(node, name)) {
      filteredNames.add(name)
    }
  }

  // Calculate in-degree for filtered packages only
  const inDegree = new Map<string, number>()
  for (const name of filteredNames) {
    let count = 0
    for (const dep of graph.get(name)!.dependencies) {
      if (filteredNames.has(dep)) {
        count++
      }
    }
    inDegree.set(name, count)
  }

  const waves: PackageInfo[][] = []
  const processed = new Set<string>()

  while (processed.size < filteredNames.size) {
    // Find all packages with no remaining dependencies (in-degree = 0)
    const wave: PackageInfo[] = []
    for (const name of filteredNames) {
      if (!processed.has(name) && inDegree.get(name) === 0) {
        wave.push(graph.get(name)!.package)
      }
    }

    if (wave.length === 0) {
      // Circular dependency detected
      const remaining = [...filteredNames].filter(n => !processed.has(n))
      throw new Error(`Circular dependency detected among: ${remaining.join(', ')}`)
    }

    waves.push(wave)

    // Mark these as processed and update in-degrees
    for (const pkg of wave) {
      processed.add(pkg.name)
      const node = graph.get(pkg.name)!
      for (const dependent of node.dependents) {
        if (filteredNames.has(dependent) && inDegree.has(dependent)) {
          inDegree.set(dependent, inDegree.get(dependent)! - 1)
        }
      }
    }
  }

  return waves
}

/**
 * Compile result for a single package
 */
interface CompileResult {
  package: PackageInfo
  skipped: boolean
  error?: Error
  time: number
  filesCount: number
  validated: boolean
  validateTime?: number
  validationSkipped?: boolean
  fromCache?: boolean
}

/**
 * Compile all packages in two phases:
 * 1. Transpile phase - fast esbuild transpilation
 * 2. Validate phase - parallel TypeScript validation via worker pool
 */
export async function compileAll (
  packages: PackageInfo[],
  options: {
    parallel?: number
    verbose?: boolean
    doValidate?: boolean
    noCache?: boolean
    list?: boolean
    toPackage?: string | null
    forceWorkers?: boolean
  } = {}
): Promise<{
  success: boolean
  compiled: number
  validated: number
  skipped: number
  errors: number
  waves: number
  time: number
  listOnly: boolean
}> {
  const {
    parallel = 4,
    verbose = false,
    doValidate = false,
    noCache = false,
    list = false,
    toPackage = null,
    forceWorkers = false
  } = options

  const startTime = performance.now()

  // Check available memory and adjust worker count
  const memoryInfo = getOptimalWorkerCount(parallel)
  const effectiveParallel = forceWorkers ? parallel : memoryInfo.workers

  // Track peak memory usage
  let peakMemoryMB = 0

  function updatePeakMemory (): void {
    const currentMem = process.memoryUsage()
    const currentMB = Math.round(currentMem.rss / 1024 / 1024)
    if (currentMB > peakMemoryMB) {
      peakMemoryMB = currentMB
    }
  }

  // Start periodic memory tracking
  const memoryCheckInterval = setInterval(updatePeakMemory, 100)
  updatePeakMemory() // Initial check

  // Start CPU tracking
  const cpuTracker = new CpuTracker(100)
  cpuTracker.start()

  if (memoryInfo.limitedByMemory && !forceWorkers && verbose) {
    console.log(`Warning: Limited workers to ${effectiveParallel} (requested ${parallel}) due to available memory: ${memoryInfo.availableMemoryMB} MB`)
  }

  if (verbose) {
    console.log(`Found ${packages.length} packages`)
  }

  // Build dependency graph
  const graph = await buildDependencyGraph(packages)
  if (verbose) {
    console.log(`Graph built with ${graph.size} nodes`)
  }

  // If --to is specified, get all dependencies of the target package
  let targetPackages: Set<string> | null = null
  if (toPackage) {
    if (!graph.has(toPackage)) {
      throw new Error(`Package "${toPackage}" not found in the project`)
    }

    // Get all dependencies + the target itself
    targetPackages = getAllDependencies(graph, toPackage)
    targetPackages.add(toPackage)

    if (verbose) {
      console.log(`Building ${toPackage} and ${targetPackages.size - 1} dependencies`)
    }
  }

  // Get waves of packages to transpile (compile transpile src/tests OR compile ui-esbuild)
  const transpileWaves = topologicalSortWaves(graph, (node, name) => {
    // Must have the right phase for transpile (src, tests, or ui-esbuild)
    const isTranspilePhase = node.phaseBuild === 'compile transpile src' ||
                             node.phaseBuild === 'compile transpile tests' ||
                             node.phaseBuild === 'compile ui-esbuild'
    if (!isTranspilePhase) {
      return false
    }
    // If --to is specified, only include target packages
    if (targetPackages && !targetPackages.has(name)) {
      return false
    }
    return true
  })

  // Get waves of packages to validate (all with compile validate)
  const validateWaves = topologicalSortWaves(graph, (node, name) => {
    // Must have compile validate phase
    if (node.phaseValidate !== 'compile validate') {
      return false
    }
    // If --to is specified, only include target packages and their dependencies
    if (targetPackages && !targetPackages.has(name)) {
      return false
    }
    return true
  })

  const totalToTranspile = transpileWaves.reduce((sum, wave) => sum + wave.length, 0)
  const totalToValidate = validateWaves.reduce((sum, wave) => sum + wave.length, 0)

  // If --list mode, just print and exit
  if (list) {
    console.log('\nCompilation order:')
    console.log('==================\n')

    let totalPackages = 0
    let totalToValidateCount = 0

    for (let i = 0; i < transpileWaves.length; i++) {
      const wave = transpileWaves[i]
      console.log(`Wave ${i + 1} (${wave.length} packages):`)

      for (const pkg of wave) {
        const node = graph.get(pkg.name)!
        const deps = [...node.dependencies].filter(d => {
          const depNode = graph.get(d)
          return depNode && (depNode.phaseBuild === 'compile transpile src' || depNode.phaseBuild === 'compile transpile tests')
        })

        const willValidate = doValidate && node.phaseValidate === 'compile validate'
        const validateMark = willValidate ? ' [+validate]' : ''

        if (deps.length > 0) {
          console.log(`  ${pkg.name}${validateMark}`)
          console.log(`    depends on: ${deps.join(', ')}`)
        } else {
          console.log(`  ${pkg.name}${validateMark}`)
        }

        totalPackages++
        if (willValidate) totalToValidateCount++
      }
      console.log()
    }

    console.log('==================')
    console.log(`Total: ${totalPackages} packages in ${transpileWaves.length} waves`)
    if (doValidate) {
      console.log(`Will validate: ${totalToValidateCount} packages`)
    }

    clearInterval(memoryCheckInterval)
    return {
      success: true,
      compiled: 0,
      validated: 0,
      skipped: packages.length - totalToTranspile,
      errors: 0,
      waves: transpileWaves.length,
      time: performance.now() - startTime,
      listOnly: true
    }
  }

  if (verbose) {
    console.log(`Packages to transpile: ${totalToTranspile} in ${transpileWaves.length} waves`)
    if (doValidate) {
      console.log(`Packages to validate: ${totalToValidate} in ${validateWaves.length} waves`)
    }
  }

  // Clean cache if requested
  if (noCache) {
    for (const [, node] of graph) {
      const validateDir = join(node.package.dir, '.validate')
      if (existsSync(validateDir)) {
        cleanDirectory(validateDir)
      }
    }
    if (verbose) {
      console.log('Cache cleaned')
    }
  }

  // Initialize worker pool if needed
  let pool: ValidateWorkerPool | null = null
  if (doValidate && totalToValidate > 0) {
    pool = await getWorkerPool(effectiveParallel)
  }

  const results = new Map<string, CompileResult>()
  const transpileCompleted = new Set<string>()
  const validateCompleted = new Set<string>()

  // Track types hashes for incremental validation
  const typesHashes = new Map<string, string>()

  // Phase 1: Transpile all packages
  async function transpileAll (): Promise<void> {
    if (transpileWaves.length === 0) return

    for (const wave of transpileWaves) {
      await Promise.all(wave.map(async (pkg) => {
        const node = graph.get(pkg.name)!
        const srcDir = node.phaseBuild === 'compile transpile tests' ? 'tests' : 'src'
        const isUiEsbuild = node.phaseBuild === 'compile ui-esbuild'

        const st = performance.now()
        try {
          const filesToTranspile = collectFiles(join(pkg.dir, srcDir))
          if (filesToTranspile.length === 0) {
            results.set(pkg.name, { package: pkg, skipped: false, time: 0, filesCount: 0, validated: false })
          } else {
            const relativeFiles = filesToTranspile.map((f) => f.replace(pkg.dir + '/', ''))

            if (isUiEsbuild) {
              await performESBuildWithSvelte(filesToTranspile, { cwd: pkg.dir })
              await generateSvelteTypes({ cwd: pkg.dir })
            } else {
              await performESBuild(relativeFiles, { srcDir, cwd: pkg.dir, outDir: 'lib' })
            }

            const time = performance.now() - st
            results.set(pkg.name, { package: pkg, skipped: false, time, filesCount: relativeFiles.length, validated: false })

            if (verbose) {
              const svelteInfo = isUiEsbuild ? ' (svelte)' : ''
              console.log(`  ${pkg.name} transpiled${svelteInfo} in ${Math.round(time * 100) / 100}ms (${relativeFiles.length} files)`)
            }
          }
        } catch (err: unknown) {
          results.set(pkg.name, {
            package: pkg,
            skipped: false,
            error: err instanceof Error ? err : new Error(String(err)),
            time: performance.now() - st,
            filesCount: 0,
            validated: false
          })
        }
        transpileCompleted.add(pkg.name)
      }))
    }
  }

  // Phase 2: Validate all packages
  async function validateAll (): Promise<void> {
    if (!doValidate || validateWaves.length === 0 || !pool) return

    if (verbose) {
      console.log(`\n  Starting parallel validation of ${totalToValidate} packages with ${effectiveParallel} workers...`)
    } else {
      console.log(`\n  Phase 2: Validating ${totalToValidate} packages...`)
    }

    for (const wave of validateWaves) {
      await Promise.all(wave.map(async (pkg) => {
        const node = graph.get(pkg.name)!

        // Initialize result if not already set
        if (!results.has(pkg.name)) {
          results.set(pkg.name, { package: pkg, skipped: false, time: 0, filesCount: 0, validated: false })
        }
        const result = results.get(pkg.name)!

        // Collect types hashes from dependencies
        const dependencyTypesHashes: Record<string, string> = {}
        for (const dep of node.dependencies) {
          if (typesHashes.has(dep)) {
            dependencyTypesHashes[dep] = typesHashes.get(dep)!
          }
        }

        const srcDir = node.phaseBuild === 'compile transpile tests' ? 'tests' : 'src'

        const st = performance.now()
        try {
          const validateResult = await pool!.validate(pkg.dir, { dependencyTypesHashes, srcDir })
          const validateTime = performance.now() - st

          if (!validateResult.success) {
            result.error = new Error(validateResult.error || 'Validation failed')
            result.validated = false
          } else {
            result.validated = true
            result.validateTime = validateTime
            result.validationSkipped = validateResult.skipped || false
            result.fromCache = validateResult.fromCache || false

            // Store types hash for dependents
            if (validateResult.typesHash) {
              typesHashes.set(pkg.name, validateResult.typesHash)
            }
          }

          if (verbose) {
            const status = result.validated ? '✓' : '✗'
            const cacheInfo = result.fromCache ? ' (hash match)' : (result.validationSkipped ? ' (cached)' : '')
            console.log(`    ${pkg.name} validated ${status} in ${Math.round(validateTime * 100) / 100}ms${cacheInfo}`)
          }
        } catch (err: unknown) {
          result.error = err instanceof Error ? err : new Error(String(err))
          result.validated = false
        }

        validateCompleted.add(pkg.name)
      }))
    }
  }

  // Execute phases
  if (verbose) {
    console.log('\n  Phase 1: Transpiling...')
  }
  await transpileAll()

  if (doValidate) {
    if (verbose) {
      console.log('\n  Phase 2: Validating...')
    }
    await validateAll()
  }

  // Cleanup
  clearInterval(memoryCheckInterval)
  cpuTracker.stop()
  if (pool) {
    await pool.terminate()
  }

  // Collect results
  let compiled = 0
  let validated = 0
  let skipped = 0
  let errors = 0

  for (const [name, result] of results) {
    if (result.error) {
      errors++
      console.error(`  ✗ ${name}: ${result.error.message}`)
    } else {
      if (result.filesCount > 0) compiled++
      if (result.validated) validated++
      if (result.skipped) skipped++
    }
  }

  const totalTime = performance.now() - startTime

  // Print summary
  console.log('\n==================')
  console.log('Build Summary:')
  console.log(`  Compiled: ${compiled}`)
  console.log(`  Validated: ${validated}`)
  console.log(`  Skipped: ${skipped}`)
  console.log(`  Errors: ${errors}`)
  console.log(`  Time: ${Math.round(totalTime)}ms`)
  console.log(`  Waves: ${transpileWaves.length}`)
  console.log('==================')

  return {
    success: errors === 0,
    compiled,
    validated,
    skipped,
    errors,
    waves: transpileWaves.length,
    time: totalTime,
    listOnly: false
  }
}
