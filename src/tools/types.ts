/**
 * Информация о пакете
 */
export interface PackageInfo {
  /** Имя пакета */
  name: string
  /** Версия пакета */
  version: string
  /** Путь к package.json относительно root */
  file: string
  /** Абсолютный путь к директории пакета */
  dir: string
  /** Зависимости пакета (имя -> версия) */
  dependencies: Record<string, string>
  /** Dev зависимости пакета (имя -> версия) */
  devDependencies: Record<string, string>
  /** Peer зависимости пакета (имя -> версия) */
  peerDependencies: Record<string, string>
  /** Optional зависимости пакета (имя -> версия) */
  optionalDependencies: Record<string, string>
  /** Все зависимости (объединение всех типов) */
  allDependencies: Record<string, string>
}

/**
 * Информация о зависимости между пакетами
 */
export interface DependencyEdge {
  /** От какого пакета */
  from: string
  /** К какому пакету */
  to: string
  /** Тип зависимости */
  type: 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies'
  /** Версия/спецификатор зависимости */
  version: string
  /** true если это workspace зависимость */
  isWorkspace: boolean
}

/**
 * Узел дерева зависимостей
 */
export interface DependencyNode {
  /** Информация о пакете */
  package: PackageInfo
  /** Прямые зависимости (только внутри репо) */
  dependencies: DependencyNode[]
  /** Пакеты, которые зависят от этого пакета */
  dependents: DependencyNode[]
  /** Уровень в дереве (0 для корневых) */
  level: number
}

/**
 * Результат построения дерева зависимостей
 */
export interface DependencyTree {
  /** Корневой путь */
  root: string
  /** Все пакеты по имени */
  packages: Map<string, PackageInfo>
  /** Все ребра зависимостей */
  edges: DependencyEdge[]
  /** Узлы дерева по имени пакета */
  nodes: Map<string, DependencyNode>
  /** Корневые узлы (нет зависимостей внутри репо) */
  roots: DependencyNode[]
  /** Листовые узлы (нет dependents внутри репо) */
  leaves: DependencyNode[]
  /** Циклические зависимости */
  cycles: string[][]
  /** Топологический порядок сборки */
  buildOrder: string[]
  /** Пакеты с ошибками парсинга */
  errors: Array<{ file: string; error: string }>
}

/**
 * Опции для форматирования дерева зависимостей
 */
export interface FormatTreeOptions {
  /** Показывать внешние зависимости */
  showExternal?: boolean
  /** Показывать dev зависимости */
  showDevDependencies?: boolean
  /** Показывать версии */
  showVersions?: boolean
  /** Максимальная глубина */
  maxDepth?: number
}

/**
 * Опции для получения транзитивных зависимостей
 */
export interface TransitiveDepsOptions {
  /** Включать dev зависимости */
  includeDev?: boolean
  /** Включать peer зависимости */
  includePeer?: boolean
  /** Включать optional зависимости */
  includeOptional?: boolean
}

/**
 * Тип использования зависимости
 */
export type DependencyUsageType = 'prod' | 'dev' | 'peer' | 'optional'

/**
 * Информация о использовании зависимости пакетом
 */
export interface DependencyUsage {
  /** Имя пакета, который использует зависимость */
  packageName: string
  /** Тип использования */
  type: DependencyUsageType
  /** Версия/спецификатор */
  version: string
  /** Является ли workspace зависимостью */
  isWorkspace: boolean
}

/**
 * Информация о внешней зависимости
 */
export interface ExternalDependencyInfo {
  /** Имя пакета */
  name: string
  /** Список использований по пакетам */
  usages: DependencyUsage[]
  /** Общее количество использований */
  totalCount: number
  /** Количество как prod зависимость */
  prodCount: number
  /** Количество как dev зависимость */
  devCount: number
  /** Количество как peer зависимость */
  peerCount: number
  /** Количество как optional зависимость */
  optionalCount: number
  /** Уникальные версии */
  versions: string[]
  /** Размер в node_modules (в байтах) */
  size?: number
  /** Признак что размер не удалось определить */
  sizeError?: string
}

/**
 * Режим фильтрации зависимостей
 */
export type DependencyMode = 'dev' | 'prod' | 'both'

/**
 * Опции для анализа внешних зависимостей
 */
export interface AnalyzeExternalDepsOptions {
  /** Вычислять размеры пакетов */
  calculateSize?: boolean
  /** Лимит для подсчета размеров */
  sizeLimit?: number
  /** Пакеты/паттерны для исключения из анализа */
  exclude?: string[]
  /** Режим фильтрации зависимостей */
  mode?: DependencyMode
}

/**
 * Результат анализа внешних зависимостей
 */
export interface ExternalDependenciesAnalysis {
  /** Корневой путь */
  root: string
  /** Все внешние зависимости по имени */
  dependencies: Map<string, ExternalDependencyInfo>
  /** Отсортированный список по частоте использования */
  byUsageCount: ExternalDependencyInfo[]
  /** Отсортированный список по размеру */
  bySize: ExternalDependencyInfo[]
  /** Общее количество уникальных внешних зависимостей */
  totalCount: number
  /** Общий размер всех внешних зависимостей */
  totalSize?: number
  /** Пакеты с ошибками чтения размера */
  sizeErrors: string[]
  /** Пакеты, которые были исключены */
  excluded: string[]
}
