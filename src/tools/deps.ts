import { promises as fs } from 'fs'
import path from 'path'
import { globby } from 'globby'
import type {
  PackageInfo,
  DependencyEdge,
  DependencyNode,
  DependencyTree,
  FormatTreeOptions,
  TransitiveDepsOptions,
  ExternalDependencyInfo,
  ExternalDependenciesAnalysis,
  DependencyUsage,
  DependencyUsageType,
  DependencyMode,
  AnalyzeExternalDepsOptions
} from './types.js'

export type {
  PackageInfo,
  DependencyEdge,
  DependencyNode,
  DependencyTree,
  FormatTreeOptions,
  TransitiveDepsOptions,
  ExternalDependencyInfo,
  ExternalDependenciesAnalysis,
  DependencyUsage,
  DependencyUsageType,
  DependencyMode,
  AnalyzeExternalDepsOptions
}

/**
 * Проверяет, является ли версия workspace зависимостью
 */
function isWorkspaceVersion (version: string): boolean {
  return version.startsWith('workspace:') || version.startsWith('link:')
}

/**
 * Загружает все пакеты из root директории
 */
async function loadPackages (root: string): Promise<{ packages: PackageInfo[]; errors: Array<{ file: string; error: string }> }> {
  const files = await globby(['**/package.json'], {
    cwd: root,
    gitignore: true,
    followSymbolicLinks: false,
    ignore: ['**/node_modules/**']
  })

  const packages: PackageInfo[] = []
  const errors: Array<{ file: string; error: string }> = []

  for (const file of files) {
    try {
      const content = await fs.readFile(path.join(root, file), 'utf8')
      const json = JSON.parse(content)

      if (!json.name || typeof json.name !== 'string') {
        errors.push({ file, error: 'Missing or invalid package name' })
        continue
      }

      const deps = json.dependencies ?? {}
      const devDeps = json.devDependencies ?? {}
      const peerDeps = json.peerDependencies ?? {}
      const optionalDeps = json.optionalDependencies ?? {}

      const allDeps: Record<string, string> = {}
      for (const [name, version] of Object.entries(deps)) {
        allDeps[name] = version as string
      }
      for (const [name, version] of Object.entries(devDeps)) {
        allDeps[name] = version as string
      }
      for (const [name, version] of Object.entries(peerDeps)) {
        allDeps[name] = version as string
      }
      for (const [name, version] of Object.entries(optionalDeps)) {
        allDeps[name] = version as string
      }

      packages.push({
        name: json.name,
        version: json.version ?? '0.0.0',
        file,
        dir: path.dirname(file),
        dependencies: deps,
        devDependencies: devDeps,
        peerDependencies: peerDeps,
        optionalDependencies: optionalDeps,
        allDependencies: allDeps
      })
    } catch (err) {
      errors.push({ file, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return { packages, errors }
}

/**
 * Строит ребра зависимостей между пакетами
 */
function buildEdges (packages: PackageInfo[]): DependencyEdge[] {
  const packageNames = new Set(packages.map(p => p.name))
  const edges: DependencyEdge[] = []

  for (const pkg of packages) {
    for (const [depName, version] of Object.entries(pkg.dependencies)) {
      if (packageNames.has(depName)) {
        edges.push({
          from: pkg.name,
          to: depName,
          type: 'dependencies',
          version,
          isWorkspace: isWorkspaceVersion(version)
        })
      }
    }

    for (const [depName, version] of Object.entries(pkg.devDependencies)) {
      if (packageNames.has(depName)) {
        edges.push({
          from: pkg.name,
          to: depName,
          type: 'devDependencies',
          version,
          isWorkspace: isWorkspaceVersion(version)
        })
      }
    }

    for (const [depName, version] of Object.entries(pkg.peerDependencies)) {
      if (packageNames.has(depName)) {
        edges.push({
          from: pkg.name,
          to: depName,
          type: 'peerDependencies',
          version,
          isWorkspace: isWorkspaceVersion(version)
        })
      }
    }

    for (const [depName, version] of Object.entries(pkg.optionalDependencies)) {
      if (packageNames.has(depName)) {
        edges.push({
          from: pkg.name,
          to: depName,
          type: 'optionalDependencies',
          version,
          isWorkspace: isWorkspaceVersion(version)
        })
      }
    }
  }

  return edges
}

/**
 * Находит циклические зависимости используя DFS
 */
function findCycles (packages: Map<string, PackageInfo>, edges: DependencyEdge[]): string[][] {
  const cycles: string[][] = []
  const visited = new Set<string>()
  const recursionStack = new Set<string>()
  const path: string[] = []

  // Строим adjacency list
  const adj = new Map<string, string[]>()
  for (const [name] of packages) {
    adj.set(name, [])
  }
  for (const edge of edges) {
    const list = adj.get(edge.from)
    if (list && !list.includes(edge.to)) {
      list.push(edge.to)
    }
  }

  function dfs (node: string): void {
    visited.add(node)
    recursionStack.add(node)
    path.push(node)

    const neighbors = adj.get(node) ?? []
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        dfs(neighbor)
      } else if (recursionStack.has(neighbor)) {
        // Найден цикл
        const cycleStart = path.indexOf(neighbor)
        const cycle = path.slice(cycleStart).concat([neighbor])
        cycles.push(cycle)
      }
    }

    path.pop()
    recursionStack.delete(node)
  }

  for (const [name] of packages) {
    if (!visited.has(name)) {
      dfs(name)
    }
  }

  // Удаляем дубликаты циклов
  const uniqueCycles: string[][] = []
  const seen = new Set<string>()
  for (const cycle of cycles) {
    const normalized = [...cycle].sort().join(',')
    if (!seen.has(normalized)) {
      seen.add(normalized)
      uniqueCycles.push(cycle)
    }
  }

  return uniqueCycles
}

/**
 * Топологическая сортировка для определения порядка сборки
 */
function topologicalSort (packages: Map<string, PackageInfo>, edges: DependencyEdge[]): string[] {
  const inDegree = new Map<string, number>()
  const adj = new Map<string, string[]>()

  // Инициализация
  for (const [name] of packages) {
    inDegree.set(name, 0)
    adj.set(name, [])
  }

  // Заполняем граф (только dependencies и peerDependencies)
  for (const edge of edges) {
    if (edge.type === 'dependencies' || edge.type === 'peerDependencies') {
      const list = adj.get(edge.to)
      if (list) {
        list.push(edge.from)
        inDegree.set(edge.from, (inDegree.get(edge.from) ?? 0) + 1)
      }
    }
  }

  // Kahn's algorithm
  const queue: string[] = []
  const result: string[] = []

  for (const [name, degree] of inDegree) {
    if (degree === 0) {
      queue.push(name)
    }
  }

  while (queue.length > 0) {
    const node = queue.shift()!
    result.push(node)

    const neighbors = adj.get(node) ?? []
    for (const neighbor of neighbors) {
      const newDegree = (inDegree.get(neighbor) ?? 0) - 1
      inDegree.set(neighbor, newDegree)
      if (newDegree === 0) {
        queue.push(neighbor)
      }
    }
  }

  // Если есть циклы, добавляем оставшиеся узлы
  if (result.length < packages.size) {
    for (const [name] of packages) {
      if (!result.includes(name)) {
        result.push(name)
      }
    }
  }

  return result
}

/**
 * Строит дерево зависимостей для всех пакетов в репозитории
 */
export async function buildDependencyTree (root: string): Promise<DependencyTree> {
  const { packages, errors } = await loadPackages(root)
  const packageMap = new Map(packages.map(p => [p.name, p]))
  const edges = buildEdges(packages)
  const cycles = findCycles(packageMap, edges)
  const buildOrder = topologicalSort(packageMap, edges)

  // Строим узлы
  const nodes = new Map<string, DependencyNode>()
  const dependentsMap = new Map<string, string[]>()

  // Инициализация
  for (const pkg of packages) {
    nodes.set(pkg.name, {
      package: pkg,
      dependencies: [],
      dependents: [],
      level: 0
    })
    dependentsMap.set(pkg.name, [])
  }

  // Заполняем dependents
  for (const edge of edges) {
    const list = dependentsMap.get(edge.to)
    if (list && !list.includes(edge.from)) {
      list.push(edge.from)
    }
  }

  // Заполняем dependencies и dependents для узлов
  for (const edge of edges) {
    const fromNode = nodes.get(edge.from)
    const toNode = nodes.get(edge.to)
    if (fromNode && toNode) {
      if (!fromNode.dependencies.includes(toNode)) {
        fromNode.dependencies.push(toNode)
      }
      if (!toNode.dependents.includes(fromNode)) {
        toNode.dependents.push(fromNode)
      }
    }
  }

  // Вычисляем уровни
  const visited = new Set<string>()
  function calculateLevel (node: DependencyNode, level: number): void {
    if (visited.has(node.package.name)) return
    visited.add(node.package.name)
    node.level = Math.max(node.level, level)
    for (const dep of node.dependencies) {
      calculateLevel(dep, level + 1)
    }
  }

  for (const [, node] of nodes) {
    if (node.dependents.length === 0) {
      calculateLevel(node, 0)
    }
  }

  // Находим корни и листья
  const roots: DependencyNode[] = []
  const leaves: DependencyNode[] = []

  for (const [, node] of nodes) {
    if (node.dependencies.length === 0) {
      roots.push(node)
    }
    if (node.dependents.length === 0) {
      leaves.push(node)
    }
  }

  return {
    root,
    packages: packageMap,
    edges,
    nodes,
    roots,
    leaves,
    cycles,
    buildOrder,
    errors
  }
}

/**
 * Форматирует дерево зависимостей для вывода
 */
export function formatDependencyTree (tree: DependencyTree, options: FormatTreeOptions = {}): string {
  const { showDevDependencies = false, showVersions = true, maxDepth = Infinity } = options

  const lines: string[] = []
  lines.push(`Dependency Tree for: ${tree.root}`)
  lines.push(`Packages: ${tree.packages.size}`)
  lines.push(`Internal dependencies: ${tree.edges.length}`)
  lines.push(`Root packages: ${tree.roots.length}`)
  lines.push(`Leaf packages: ${tree.leaves.length}`)

  if (tree.cycles.length > 0) {
    lines.push('')
    lines.push('⚠️  CIRCULAR DEPENDENCIES DETECTED:')
    for (const cycle of tree.cycles) {
      lines.push(`  ${cycle.join(' → ')}`)
    }
  }

  if (tree.errors.length > 0) {
    lines.push('')
    lines.push('⚠️  ERRORS:')
    for (const err of tree.errors) {
      lines.push(`  ${err.file}: ${err.error}`)
    }
  }

  lines.push('')
  lines.push('Build Order:')
  tree.buildOrder.forEach((name, i) => {
    lines.push(`  ${i + 1}. ${name}`)
  })

  lines.push('')
  lines.push('Dependency Tree:')

  const printed = new Set<string>()

  function printNode (node: DependencyNode, indent: string, depth: number): void {
    if (depth > maxDepth) return

    const isPrinted = printed.has(node.package.name)
    if (isPrinted) {
      lines.push(`${indent}↻ ${node.package.name}${showVersions ? `@${node.package.version}` : ''} (see above)`)
      return
    }

    printed.add(node.package.name)

    const deps = node.dependencies.filter(d => {
      if (!showDevDependencies && node.package.devDependencies[d.package.name]) {
        return false
      }
      return true
    })

    const prefix = deps.length > 0 ? '┬' : '─'
    lines.push(`${indent}${prefix} ${node.package.name}${showVersions ? `@${node.package.version}` : ''}`)

    for (let i = 0; i < deps.length; i++) {
      const isLast = i === deps.length - 1
      const childIndent = indent + (isLast ? '  ' : '│ ')
      const childPrefix = isLast ? '└─' : '├─'
      lines.push(`${childIndent}${childPrefix}`)
      printNode(deps[i], childIndent + (isLast ? '  ' : '│ '), depth + 1)
    }
  }

  // Сортируем корни по имени
  const sortedRoots = [...tree.roots].sort((a, b) => a.package.name.localeCompare(b.package.name))
  for (const root of sortedRoots) {
    printNode(root, '', 0)
    lines.push('')
  }

  // Пакеты, которые не являются корнями (в циклах)
  const nonRoots: DependencyNode[] = []
  for (const [, node] of tree.nodes) {
    if (node.dependencies.length > 0 && !sortedRoots.includes(node)) {
      // Проверяем, что ещё не выведен
      if (!printed.has(node.package.name)) {
        nonRoots.push(node)
      }
    }
  }

  if (nonRoots.length > 0) {
    lines.push('Packages in cycles (not shown above):')
    for (const node of nonRoots.sort((a, b) => a.package.name.localeCompare(b.package.name))) {
      printNode(node, '', 0)
      lines.push('')
    }
  }

  return lines.join('\n')
}

/**
 * Получает зависимости пакета с транзитивными зависимостями
 */
export function getTransitiveDependencies (
  tree: DependencyTree,
  packageName: string,
  options: TransitiveDepsOptions = {}
): Set<string> {
  const { includeDev = false, includePeer = true, includeOptional = false } = options

  const result = new Set<string>()
  const visited = new Set<string>()

  function visit (name: string): void {
    if (visited.has(name)) return
    visited.add(name)

    const node = tree.nodes.get(name)
    if (!node) return

    for (const edge of tree.edges) {
      if (edge.from === name) {
        if (edge.type === 'dependencies' ||
            (includeDev && edge.type === 'devDependencies') ||
            (includePeer && edge.type === 'peerDependencies') ||
            (includeOptional && edge.type === 'optionalDependencies')) {
          result.add(edge.to)
          visit(edge.to)
        }
      }
    }
  }

  visit(packageName)
  return result
}

/**
 * Получает пакеты, которые зависят от данного пакета (transitive)
 */
export function getTransitiveDependents (tree: DependencyTree, packageName: string): Set<string> {
  const result = new Set<string>()
  const visited = new Set<string>()

  function visit (name: string): void {
    if (visited.has(name)) return
    visited.add(name)

    for (const edge of tree.edges) {
      if (edge.to === name) {
        result.add(edge.from)
        visit(edge.from)
      }
    }
  }

  visit(packageName)
  return result
}

// ==================== EXTERNAL DEPENDENCIES ANALYSIS ====================

/**
 * Рекурсивно подсчитывает размер директории с ограничением глубины
 */
async function calculateDirSize (dirPath: string, maxDepth: number = 3, currentDepth: number = 0): Promise<number> {
  if (currentDepth > maxDepth) return 0

  let totalSize = 0

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      // Пропускаем node_modules внутри пакета
      if (entry.name === 'node_modules') continue

      const fullPath = path.join(dirPath, entry.name)

      if (entry.isDirectory()) {
        totalSize += await calculateDirSize(fullPath, maxDepth, currentDepth + 1)
      } else if (entry.isFile()) {
        try {
          const stats = await fs.stat(fullPath)
          totalSize += stats.size
        } catch {
          // Игнорируем ошибки доступа к файлам
        }
      }
    }
  } catch {
    // Игнорируем ошибки доступа к директориям
  }

  return totalSize
}

/**
 * Получает размер пакета из node_modules
 */
async function getPackageSize (root: string, packageName: string): Promise<{ size: number; error?: string }> {
  // Пробуем найти пакет в node_modules
  const possiblePaths = [
    path.join(root, 'node_modules', packageName),
    // Для scoped пакетов (@scope/name)
    path.join(root, 'node_modules', packageName.split('/')[0], packageName.split('/')[1] ?? '')
  ]

  for (const pkgPath of possiblePaths) {
    try {
      const stats = await fs.stat(pkgPath)
      if (stats.isDirectory()) {
        const size = await calculateDirSize(pkgPath)
        return { size }
      }
    } catch {
      // Пробуем следующий путь
    }
  }

  // Пробуем найти в поддиректориях packages (для monorepo) - ограничиваем глубину поиска
  try {
    // Используем более специфичный паттерн чтобы ограничить результаты
    const globPatterns = [
      `node_modules/${packageName}`,
      `*/node_modules/${packageName}`,
      `packages/*/node_modules/${packageName}`
    ]
    const dirs = await globby(globPatterns, {
      cwd: root,
      onlyDirectories: true,
      absolute: true
    })

    // Берем только первые 5 результатов
    for (const dir of dirs.slice(0, 5)) {
      try {
        const size = await calculateDirSize(dir)
        if (size > 0) {
          return { size }
        }
      } catch {
        // Пробуем следующую директорию
      }
    }
  } catch {
    // Игнорируем ошибки globby
  }

  return { size: 0, error: 'Not found in node_modules' }
}

/**
 * Проверяет, соответствует ли имя пакета паттерну исключения
 * Поддерживает glob-style паттерны: @scope/*, package-*, etc.
 */
function matchesExcludePattern (packageName: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    // Точное совпадение
    if (packageName === pattern) {
      return true
    }

    // Glob-style паттерн
    if (pattern.includes('*')) {
      // Преобразуем glob в regex
      const regexPattern = pattern
        .replace(/\./g, '\\.') // Экранируем точки
        .replace(/\*\*/g, '{{GLOBSTAR}}') // Временный маркер для **
        .replace(/\*/g, '[^/]*') // * = любые символы кроме /
        .replace(/\{\{GLOBSTAR\}\}/g, '.*') // ** = любые символы

      const regex = new RegExp(`^${regexPattern}$`)
      if (regex.test(packageName)) {
        return true
      }
    }
  }
  return false
}

/**
 * Анализирует все внешние зависимости в монорепозитории
 */
export async function analyzeExternalDependencies (
  root: string,
  options: AnalyzeExternalDepsOptions = {}
): Promise<ExternalDependenciesAnalysis> {
  const { calculateSize = true, sizeLimit = 25, exclude = [], mode = 'both' } = options

  const { packages } = await loadPackages(root)
  const internalPackageNames = new Set(packages.map(p => p.name))

  // Проверяем, нужно ли фильтровать по типу зависимости
  function shouldIncludeType (type: DependencyUsageType): boolean {
    switch (mode) {
      case 'prod':
        return type === 'prod' || type === 'peer' || type === 'optional'
      case 'dev':
        return type === 'dev'
      case 'both':
      default:
        return true
    }
  }

  // Собираем все внешние зависимости
  const externalDeps = new Map<string, ExternalDependencyInfo>()

  function addUsage (
    depName: string,
    version: string,
    packageName: string,
    type: DependencyUsageType
  ): void {
    let info = externalDeps.get(depName)

    if (!info) {
      info = {
        name: depName,
        usages: [],
        totalCount: 0,
        prodCount: 0,
        devCount: 0,
        peerCount: 0,
        optionalCount: 0,
        versions: []
      }
      externalDeps.set(depName, info)
    }

    // Добавляем использование
    const isWorkspace = isWorkspaceVersion(version)
    info.usages.push({
      packageName,
      type,
      version,
      isWorkspace
    })

    // Обновляем счетчики
    info.totalCount++
    switch (type) {
      case 'prod':
        info.prodCount++
        break
      case 'dev':
        info.devCount++
        break
      case 'peer':
        info.peerCount++
        break
      case 'optional':
        info.optionalCount++
        break
    }

    // Добавляем версию если новая
    if (!info.versions.includes(version)) {
      info.versions.push(version)
    }
  }

  // Собираем список исключенных пакетов для отчета
  const excludedPackages: string[] = []

  // Проходим по всем пакетам и собираем внешние зависимости
  for (const pkg of packages) {
    // dependencies -> prod
    if (shouldIncludeType('prod')) {
      for (const [depName, version] of Object.entries(pkg.dependencies)) {
        if (!internalPackageNames.has(depName) && !matchesExcludePattern(depName, exclude)) {
          addUsage(depName, version, pkg.name, 'prod')
        } else if (matchesExcludePattern(depName, exclude) && !excludedPackages.includes(depName)) {
          excludedPackages.push(depName)
        }
      }
    }

    // devDependencies -> dev
    if (shouldIncludeType('dev')) {
      for (const [depName, version] of Object.entries(pkg.devDependencies)) {
        if (!internalPackageNames.has(depName) && !matchesExcludePattern(depName, exclude)) {
          addUsage(depName, version, pkg.name, 'dev')
        } else if (matchesExcludePattern(depName, exclude) && !excludedPackages.includes(depName)) {
          excludedPackages.push(depName)
        }
      }
    }

    // peerDependencies -> peer
    if (shouldIncludeType('prod')) {
      for (const [depName, version] of Object.entries(pkg.peerDependencies)) {
        if (!internalPackageNames.has(depName) && !matchesExcludePattern(depName, exclude)) {
          addUsage(depName, version, pkg.name, 'peer')
        } else if (matchesExcludePattern(depName, exclude) && !excludedPackages.includes(depName)) {
          excludedPackages.push(depName)
        }
      }
    }

    // optionalDependencies -> optional
    if (shouldIncludeType('prod')) {
      for (const [depName, version] of Object.entries(pkg.optionalDependencies)) {
        if (!internalPackageNames.has(depName) && !matchesExcludePattern(depName, exclude)) {
          addUsage(depName, version, pkg.name, 'optional')
        } else if (matchesExcludePattern(depName, exclude) && !excludedPackages.includes(depName)) {
          excludedPackages.push(depName)
        }
      }
    }
  }

  // Считаем размеры если нужно
  const sizeErrors: string[] = []
  let totalSize = 0

  if (calculateSize) {
    // Сортируем по частоте использования для приоритета
    const sortedByUsage = [...externalDeps.values()].sort((a, b) => b.totalCount - a.totalCount)

    // Считаем размеры только для top sizeLimit по использованию
    const toCalculate = sortedByUsage.slice(0, sizeLimit)

    // Считаем последовательно чтобы не перегружать память
    for (const dep of toCalculate) {
      const { size, error } = await getPackageSize(root, dep.name)
      if (error) {
        dep.sizeError = error
        sizeErrors.push(`${dep.name}: ${error}`)
      } else {
        dep.size = size
        totalSize += size
      }
    }
  }

  // Сортируем результаты
  const byUsageCount = [...externalDeps.values()].sort((a, b) => b.totalCount - a.totalCount)
  const bySize = [...externalDeps.values()]
    .filter(d => d.size !== undefined)
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))

  return {
    root,
    dependencies: externalDeps,
    byUsageCount,
    bySize,
    totalCount: externalDeps.size,
    totalSize: calculateSize ? totalSize : undefined,
    sizeErrors,
    excluded: excludedPackages.sort()
  }
}

/**
 * Форматирует размер в человекочитаемый формат
 */
function formatSize (bytes: number): string {
  if (bytes === 0) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const k = 1024
  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${units[i]}`
}

/**
 * Форматирует результаты анализа внешних зависимостей
 */
export function formatExternalDependenciesAnalysis (
  analysis: ExternalDependenciesAnalysis,
  options: {
    topCount?: number
    bySize?: boolean
    showDetails?: boolean
    mode?: DependencyMode
  } = {}
): string {
  const { topCount = 25, bySize = true, showDetails = false, mode = 'both' } = options

  const modeLabels: Record<DependencyMode, string> = {
    prod: 'Production (prod + peer + optional)',
    dev: 'Development only',
    both: 'All dependencies'
  }

  const lines: string[] = []
  lines.push('='.repeat(80))
  lines.push('EXTERNAL DEPENDENCIES ANALYSIS')
  lines.push('='.repeat(80))
  lines.push(`
Root: ${analysis.root}`)
  lines.push(`Filter mode: ${modeLabels[mode]}`)
  lines.push(`Total unique external dependencies: ${analysis.totalCount}`)

  if (analysis.totalSize !== undefined) {
    lines.push(`Total size (calculated): ${formatSize(analysis.totalSize)}`)
  }

  if (analysis.excluded.length > 0) {
    lines.push(`\n🚫 Excluded packages: ${analysis.excluded.length}`)
    for (const pkg of analysis.excluded) {
      lines.push(`  - ${pkg}`)
    }
  }

  if (analysis.sizeErrors.length > 0 && showDetails) {
    lines.push(`\n⚠️  Size calculation errors: ${analysis.sizeErrors.length}`)
  }

  // Топ по размеру
  if (bySize && analysis.bySize.length > 0) {
    lines.push('')
    lines.push('-'.repeat(80))
    lines.push(`TOP ${topCount} DEPENDENCIES BY SIZE`)
    lines.push('-'.repeat(80))
    lines.push(`${'Rank'.padEnd(6)} ${'Size'.padEnd(12)} ${'Used'.padEnd(6)} ${'Package Name'.padEnd(40)} ${'Type Breakdown'}`)
    lines.push('-'.repeat(80))

    const topBySize = analysis.bySize.slice(0, topCount)
    topBySize.forEach((dep, idx) => {
      const size = dep.size !== undefined ? formatSize(dep.size) : 'N/A'
      const typeBreakdown = [
        dep.prodCount > 0 ? `prod:${dep.prodCount}` : '',
        dep.devCount > 0 ? `dev:${dep.devCount}` : '',
        dep.peerCount > 0 ? `peer:${dep.peerCount}` : '',
        dep.optionalCount > 0 ? `opt:${dep.optionalCount}` : ''
      ].filter(Boolean).join(' ')

      lines.push(
        `${(idx + 1).toString().padEnd(6)} ` +
        `${size.padEnd(12)} ` +
        `${dep.totalCount.toString().padEnd(6)} ` +
        `${dep.name.padEnd(40)} ` +
        `${typeBreakdown}`
      )

      if (showDetails && dep.versions.length > 1) {
        lines.push(`       Versions: ${dep.versions.join(', ')}`)
      }
    })
  }

  // Топ по использованию
  lines.push('')
  lines.push('-'.repeat(80))
  lines.push(`TOP ${topCount} DEPENDENCIES BY USAGE COUNT`)
  lines.push('-'.repeat(80))
  lines.push(`${'Rank'.padEnd(6)} ${'Used'.padEnd(6)} ${'Size'.padEnd(12)} ${'Package Name'.padEnd(40)} ${'Type Breakdown'}`)
  lines.push('-'.repeat(80))

  const topByUsage = analysis.byUsageCount.slice(0, topCount)
  topByUsage.forEach((dep, idx) => {
    const size = dep.size !== undefined ? formatSize(dep.size) : 'N/A'
    const typeBreakdown = [
      dep.prodCount > 0 ? `prod:${dep.prodCount}` : '',
      dep.devCount > 0 ? `dev:${dep.devCount}` : '',
      dep.peerCount > 0 ? `peer:${dep.peerCount}` : '',
      dep.optionalCount > 0 ? `opt:${dep.optionalCount}` : ''
    ].filter(Boolean).join(' ')

    lines.push(
      `${(idx + 1).toString().padEnd(6)} ` +
      `${dep.totalCount.toString().padEnd(6)} ` +
      `${size.padEnd(12)} ` +
      `${dep.name.padEnd(40)} ` +
      `${typeBreakdown}`
    )
  })

  // Статистика по типам
  lines.push('')
  lines.push('-'.repeat(80))
  lines.push('DEPENDENCY TYPE STATISTICS')
  lines.push('-'.repeat(80))

  const totalUsages = [...analysis.dependencies.values()].reduce((sum, d) => sum + d.totalCount, 0)
  const totalProd = [...analysis.dependencies.values()].reduce((sum, d) => sum + d.prodCount, 0)
  const totalDev = [...analysis.dependencies.values()].reduce((sum, d) => sum + d.devCount, 0)
  const totalPeer = [...analysis.dependencies.values()].reduce((sum, d) => sum + d.peerCount, 0)
  const totalOptional = [...analysis.dependencies.values()].reduce((sum, d) => sum + d.optionalCount, 0)

  lines.push(`Total dependency usages: ${totalUsages}`)
  lines.push(`  Production:  ${totalProd} (${((totalProd / totalUsages) * 100).toFixed(1)}%)`)
  lines.push(`  Development: ${totalDev} (${((totalDev / totalUsages) * 100).toFixed(1)}%)`)
  lines.push(`  Peer:        ${totalPeer} (${((totalPeer / totalUsages) * 100).toFixed(1)}%)`)
  lines.push(`  Optional:    ${totalOptional} (${((totalOptional / totalUsages) * 100).toFixed(1)}%)`)

  // Пакеты с множественными версиями
  const multiVersion = [...analysis.dependencies.values()]
    .filter(d => d.versions.length > 1)
    .sort((a, b) => b.versions.length - a.versions.length)

  if (multiVersion.length > 0) {
    lines.push('')
    lines.push('-'.repeat(80))
    lines.push(`PACKAGES WITH MULTIPLE VERSIONS (${multiVersion.length})`)
    lines.push('-'.repeat(80))

    for (const dep of multiVersion.slice(0, topCount)) {
      lines.push(`  ${dep.name}: ${dep.versions.length} versions`)
      if (showDetails) {
        for (const usage of dep.usages) {
          lines.push(`    - ${usage.packageName}: ${usage.version}`)
        }
      }
    }
  }

  lines.push('')
  lines.push('='.repeat(80))

  return lines.join('\n')
}

/**
 * Получает dev/prod разбиение для конкретного пакета
 */
export function getPackageDependencyTypes (
  tree: DependencyTree,
  packageName: string
): {
    prod: string[]
    dev: string[]
    peer: string[]
    optional: string[]
  } {
  const result = {
    prod: [] as string[],
    dev: [] as string[],
    peer: [] as string[],
    optional: [] as string[]
  }

  const pkg = tree.packages.get(packageName)
  if (!pkg) return result

  // Внутренние зависимости
  for (const edge of tree.edges) {
    if (edge.from === packageName) {
      switch (edge.type) {
        case 'dependencies':
          result.prod.push(edge.to)
          break
        case 'devDependencies':
          result.dev.push(edge.to)
          break
        case 'peerDependencies':
          result.peer.push(edge.to)
          break
        case 'optionalDependencies':
          result.optional.push(edge.to)
          break
      }
    }
  }

  return result
}

/**
 * Форматирует разбиение зависимостей по типам для пакета
 */
export function formatPackageDependencyTypes (
  tree: DependencyTree,
  packageName: string
): string {
  const types = getPackageDependencyTypes(tree, packageName)
  const pkg = tree.packages.get(packageName)

  if (!pkg) {
    return `Package "${packageName}" not found`
  }

  const lines: string[] = []
  lines.push(`Dependency types for ${packageName}:`)
  lines.push('')

  if (types.prod.length > 0) {
    lines.push(`Production dependencies (${types.prod.length}):`)
    for (const dep of types.prod.sort()) {
      lines.push(`  📦 ${dep}`)
    }
    lines.push('')
  }

  if (types.dev.length > 0) {
    lines.push(`Development dependencies (${types.dev.length}):`)
    for (const dep of types.dev.sort()) {
      lines.push(`  🔧 ${dep}`)
    }
    lines.push('')
  }

  if (types.peer.length > 0) {
    lines.push(`Peer dependencies (${types.peer.length}):`)
    for (const dep of types.peer.sort()) {
      lines.push(`  🔗 ${dep}`)
    }
    lines.push('')
  }

  if (types.optional.length > 0) {
    lines.push(`Optional dependencies (${types.optional.length}):`)
    for (const dep of types.optional.sort()) {
      lines.push(`  ⚪ ${dep}`)
    }
  }

  const total = types.prod.length + types.dev.length + types.peer.length + types.optional.length
  lines.push('')
  lines.push(`Total internal dependencies: ${total}`)

  // Внешние зависимости
  const externalDeps = Object.keys(pkg.allDependencies).filter(
    dep => !tree.packages.has(dep)
  )

  if (externalDeps.length > 0) {
    lines.push(`External dependencies: ${externalDeps.length}`)
  }

  return lines.join('\n')
}

// ==================== WHERE USED ====================

/**
 * Результат поиска где используется зависимость
 */
export interface WhereUsedResult {
  /** Имя искомой зависимости */
  dependencyName: string
  /** Найдена ли зависимость */
  found: boolean
  /** Является ли внутренней зависимостью */
  isInternal: boolean
  /** Режим фильтрации */
  mode: DependencyMode
  /** Использования внутренней зависимости */
  internalUsages: Array<{
    packageName: string
    packagePath: string
    type: 'prod' | 'dev' | 'peer' | 'optional'
    version: string
  }>
  /** Использования внешней зависимости */
  externalUsages: Array<{
    packageName: string
    packagePath: string
    type: 'prod' | 'dev' | 'peer' | 'optional'
    version: string
  }>
  /** Всего использований (после фильтрации) */
  totalUsages: number
  /** Всего использований (до фильтрации) */
  totalUsagesBeforeFilter: number
}

/**
 * Проверяет соответствие типа зависимости режиму фильтрации
 */
function matchesMode (type: 'prod' | 'dev' | 'peer' | 'optional', mode: DependencyMode): boolean {
  switch (mode) {
    case 'prod':
      return type === 'prod' || type === 'peer' || type === 'optional'
    case 'dev':
      return type === 'dev'
    case 'both':
      return true
    default:
      return true
  }
}

/**
 * Находит где используется зависимость (внутренняя или внешняя)
 */
export async function findWhereUsed (
  root: string,
  dependencyName: string,
  mode: DependencyMode = 'prod'
): Promise<WhereUsedResult> {
  const { packages } = await loadPackages(root)
  const internalPackageNames = new Set(packages.map(p => p.name))
  const isInternal = internalPackageNames.has(dependencyName)

  const result: WhereUsedResult = {
    dependencyName,
    found: false,
    isInternal,
    mode,
    internalUsages: [],
    externalUsages: [],
    totalUsages: 0,
    totalUsagesBeforeFilter: 0
  }

  for (const pkg of packages) {
    // Проверяем все типы зависимостей
    const checks: Array<[Record<string, string>, 'prod' | 'dev' | 'peer' | 'optional']> = [
      [pkg.dependencies, 'prod'],
      [pkg.devDependencies, 'dev'],
      [pkg.peerDependencies, 'peer'],
      [pkg.optionalDependencies, 'optional']
    ]

    for (const [deps, type] of checks) {
      if (deps[dependencyName] !== undefined) {
        result.found = true
        result.totalUsagesBeforeFilter++

        // Проверяем соответствие режиму
        if (matchesMode(type, mode)) {
          const usage = {
            packageName: pkg.name,
            packagePath: pkg.file,
            type,
            version: deps[dependencyName]
          }

          if (isInternal) {
            result.internalUsages.push(usage)
          } else {
            result.externalUsages.push(usage)
          }
          result.totalUsages++
        }
      }
    }
  }

  return result
}

/**
 * Форматирует результат поиска где используется зависимость
 */
export function formatWhereUsedResult (result: WhereUsedResult): string {
  const lines: string[] = []

  const modeLabels: Record<DependencyMode, string> = {
    prod: 'Production only (prod + peer + optional)',
    dev: 'Development only',
    both: 'All dependencies'
  }

  lines.push('='.repeat(80))
  lines.push(`WHERE IS "${result.dependencyName}" USED?`)
  lines.push('='.repeat(80))

  if (!result.found) {
    lines.push('')
    lines.push(`❌ Dependency "${result.dependencyName}" not found in any package.`)
    lines.push('')
    lines.push('='.repeat(80))
    return lines.join('\n')
  }

  lines.push('')
  lines.push(`Type: ${result.isInternal ? '🔹 Internal (workspace)' : '📦 External (npm)'}`)
  lines.push(`Filter mode: ${modeLabels[result.mode]}`)
  lines.push(`Total usages: ${result.totalUsages}`)

  if (result.totalUsagesBeforeFilter !== result.totalUsages) {
    lines.push(`  (filtered from ${result.totalUsagesBeforeFilter} total usages)`)
  }

  if (result.isInternal && result.internalUsages.length > 0) {
    lines.push('')
    lines.push('-'.repeat(80))
    lines.push('INTERNAL DEPENDENCIES (dependents)')
    lines.push('-'.repeat(80))

    // Группируем по типу
    const byType: Record<string, typeof result.internalUsages> = {
      prod: [],
      dev: [],
      peer: [],
      optional: []
    }

    for (const usage of result.internalUsages) {
      byType[usage.type].push(usage)
    }

    const typeLabels: Record<string, string> = {
      prod: '📦 Production',
      dev: '🔧 Development',
      peer: '🔗 Peer',
      optional: '⚪ Optional'
    }

    for (const [type, usages] of Object.entries(byType)) {
      if (usages.length > 0) {
        lines.push('')
        lines.push(`${typeLabels[type]} (${usages.length}):`)
        for (const usage of usages.sort((a, b) => a.packageName.localeCompare(b.packageName))) {
          lines.push(`  ${usage.packageName.padEnd(50)} ${usage.version}`)
          lines.push(`    ${usage.packagePath}`)
        }
      }
    }
  }

  if (result.externalUsages.length > 0) {
    lines.push('')
    lines.push('-'.repeat(80))
    lines.push('EXTERNAL DEPENDENCY USAGES')
    lines.push('-'.repeat(80))

    // Группируем по типу
    const byType: Record<string, typeof result.externalUsages> = {
      prod: [],
      dev: [],
      peer: [],
      optional: []
    }

    for (const usage of result.externalUsages) {
      byType[usage.type].push(usage)
    }

    const typeLabels: Record<string, string> = {
      prod: '📦 Production',
      dev: '🔧 Development',
      peer: '🔗 Peer',
      optional: '⚪ Optional'
    }

    for (const [type, usages] of Object.entries(byType)) {
      if (usages.length > 0) {
        lines.push('')
        lines.push(`${typeLabels[type]} (${usages.length}):`)
        for (const usage of usages.sort((a, b) => a.packageName.localeCompare(b.packageName))) {
          lines.push(`  ${usage.packageName.padEnd(50)} ${usage.version}`)
          lines.push(`    ${usage.packagePath}`)
        }
      }
    }

    // Показываем уникальные версии
    const allVersions = [...new Set(result.externalUsages.map(u => u.version))].sort()
    if (allVersions.length > 1) {
      lines.push('')
      lines.push(`⚠️  Multiple versions detected: ${allVersions.join(', ')}`)
    }
  }

  lines.push('')
  lines.push('='.repeat(80))

  return lines.join('\n')
}
