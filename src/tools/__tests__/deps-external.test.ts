import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import {
  analyzeExternalDependencies,
  formatExternalDependenciesAnalysis,
  formatPackageDependencyTypes, buildDependencyTree
} from '../deps.js'

describe('analyzeExternalDependencies', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yamrm-ext-test-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  async function createPackage (
    dir: string,
    name: string,
    version: string,
    deps: Record<string, string> = {},
    devDeps: Record<string, string> = {},
    peerDeps: Record<string, string> = {},
    optionalDeps: Record<string, string> = {}
  ): Promise<void> {
    const pkgDir = path.join(tempDir, dir)
    await fs.mkdir(pkgDir, { recursive: true })
    await fs.writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name,
        version,
        dependencies: deps,
        devDependencies: devDeps,
        peerDependencies: peerDeps,
        optionalDependencies: optionalDeps
      }, null, 2)
    )
  }

  describe('basic functionality', () => {
    it('should return empty analysis for no packages', async () => {
      const analysis = await analyzeExternalDependencies(tempDir)

      expect(analysis.totalCount).toBe(0)
      expect(analysis.dependencies.size).toBe(0)
      expect(analysis.byUsageCount).toHaveLength(0)
    })

    it('should detect external dependencies', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0', { lodash: '^4.0.0' })

      const analysis = await analyzeExternalDependencies(tempDir, { calculateSize: false })

      expect(analysis.totalCount).toBe(1)
      expect(analysis.dependencies.has('lodash')).toBe(true)

      const lodash = analysis.dependencies.get('lodash')!
      expect(lodash.totalCount).toBe(1)
      expect(lodash.prodCount).toBe(1)
      expect(lodash.devCount).toBe(0)
    })

    it('should distinguish between prod and dev dependencies', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0',
        { lodash: '^4.0.0' },
        { jest: '^29.0.0' }
      )

      const analysis = await analyzeExternalDependencies(tempDir, { calculateSize: false })

      expect(analysis.totalCount).toBe(2)

      const lodash = analysis.dependencies.get('lodash')!
      expect(lodash.prodCount).toBe(1)
      expect(lodash.devCount).toBe(0)
      expect(lodash.usages[0].type).toBe('prod')

      const jest = analysis.dependencies.get('jest')!
      expect(jest.prodCount).toBe(0)
      expect(jest.devCount).toBe(1)
      expect(jest.usages[0].type).toBe('dev')
    })

    it('should count multiple usages of same package', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0', { lodash: '^4.0.0' })
      await createPackage('pkg-b', 'package-b', '1.0.0', { lodash: '^4.17.0' })
      await createPackage('pkg-c', 'package-c', '1.0.0', { lodash: '^4.17.21' })

      const analysis = await analyzeExternalDependencies(tempDir, { calculateSize: false })

      const lodash = analysis.dependencies.get('lodash')!
      expect(lodash.totalCount).toBe(3)
      expect(lodash.versions).toHaveLength(3)
      expect(lodash.versions).toContain('^4.0.0')
      expect(lodash.versions).toContain('^4.17.0')
      expect(lodash.versions).toContain('^4.17.21')
    })

    it('should detect peer dependencies', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0', {}, {}, { react: '^18.0.0' })

      const analysis = await analyzeExternalDependencies(tempDir, { calculateSize: false })

      const react = analysis.dependencies.get('react')!
      expect(react.peerCount).toBe(1)
      expect(react.usages[0].type).toBe('peer')
    })

    it('should detect optional dependencies', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0', {}, {}, {}, { fsevents: '^2.0.0' })

      const analysis = await analyzeExternalDependencies(tempDir, { calculateSize: false })

      const fsevents = analysis.dependencies.get('fsevents')!
      expect(fsevents.optionalCount).toBe(1)
      expect(fsevents.usages[0].type).toBe('optional')
    })

    it('should ignore internal dependencies', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0')
      await createPackage('pkg-b', 'package-b', '1.0.0', { 'package-a': 'workspace:^' })
      await createPackage('pkg-c', 'package-c', '1.0.0', { lodash: '^4.0.0' })

      const analysis = await analyzeExternalDependencies(tempDir, { calculateSize: false })

      expect(analysis.totalCount).toBe(1)
      expect(analysis.dependencies.has('lodash')).toBe(true)
      expect(analysis.dependencies.has('package-a')).toBe(false)
    })
  })

  describe('sorting', () => {
    it('should sort by usage count correctly', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0', { rare: '^1.0.0' })
      await createPackage('pkg-b', 'package-b', '1.0.0', { common: '^1.0.0' })
      await createPackage('pkg-c', 'package-c', '1.0.0', { common: '^1.0.0' })
      await createPackage('pkg-d', 'package-d', '1.0.0', { common: '^1.0.0' })

      const analysis = await analyzeExternalDependencies(tempDir, { calculateSize: false })

      expect(analysis.byUsageCount[0].name).toBe('common')
      expect(analysis.byUsageCount[0].totalCount).toBe(3)
      expect(analysis.byUsageCount[1].name).toBe('rare')
      expect(analysis.byUsageCount[1].totalCount).toBe(1)
    })
  })

  describe('formatting', () => {
    it('should format analysis without errors', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0', { lodash: '^4.0.0' })
      await createPackage('pkg-b', 'package-b', '1.0.0',
        { lodash: '^4.0.0' },
        { jest: '^29.0.0' }
      )

      const analysis = await analyzeExternalDependencies(tempDir, { calculateSize: false })
      const formatted = formatExternalDependenciesAnalysis(analysis, { topCount: 10 })

      expect(formatted).toContain('EXTERNAL DEPENDENCIES ANALYSIS')
      expect(formatted).toContain('lodash')
      expect(formatted).toContain('jest')
      expect(formatted).toContain('Total unique external dependencies: 2')
    })

    it('should show type statistics', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0',
        { lodash: '^4.0.0' },
        { jest: '^29.0.0' }
      )

      const analysis = await analyzeExternalDependencies(tempDir, { calculateSize: false })
      const formatted = formatExternalDependenciesAnalysis(analysis)

      expect(formatted).toContain('DEPENDENCY TYPE STATISTICS')
      expect(formatted).toContain('Production:')
      expect(formatted).toContain('Development:')
    })

    it('should identify packages with multiple versions', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0', { lodash: '^4.0.0' })
      await createPackage('pkg-b', 'package-b', '1.0.0', { lodash: '^4.17.0' })

      const analysis = await analyzeExternalDependencies(tempDir, { calculateSize: false })
      const formatted = formatExternalDependenciesAnalysis(analysis, { showDetails: true })

      expect(formatted).toContain('PACKAGES WITH MULTIPLE VERSIONS')
      expect(formatted).toContain('lodash: 2 versions')
    })
  })

  describe('package dependency types', () => {
    it('should format dependency types for a package', async () => {
      await createPackage('pkg-base', 'package-base', '1.0.0')
      await createPackage('pkg-utils', 'package-utils', '1.0.0')
      await createPackage('pkg-a', 'package-a', '1.0.0',
        { 'package-base': 'workspace:^' },
        { 'package-utils': 'workspace:^' }
      )

      const tree = await buildDependencyTree(tempDir)
      const formatted = formatPackageDependencyTypes(tree, 'package-a')

      expect(formatted).toContain('package-a')
      expect(formatted).toContain('Production dependencies')
      expect(formatted).toContain('package-base')
      expect(formatted).toContain('Development dependencies')
      expect(formatted).toContain('package-utils')
    })

    it('should handle package not found', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0')

      const tree = await buildDependencyTree(tempDir)
      const formatted = formatPackageDependencyTypes(tree, 'nonexistent')

      expect(formatted).toContain('not found')
    })
  })
})

describe('analyzeExternalDependencies with exclude', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yamrm-external-exclude-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  async function createPackage (
    dir: string,
    name: string,
    version: string,
    deps: Record<string, string> = {},
    devDeps: Record<string, string> = {}
  ): Promise<void> {
    const pkgDir = path.join(tempDir, dir)
    await fs.mkdir(pkgDir, { recursive: true })
    await fs.writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name,
        version,
        dependencies: deps,
        devDependencies: devDeps
      }, null, 2)
    )
  }

  it('should exclude single package', async () => {
    await createPackage('pkg-a', 'package-a', '1.0.0', { lodash: '^4.0.0', react: '^18.0.0' })
    await createPackage('pkg-b', 'package-b', '1.0.0', { lodash: '^4.0.0' })

    const analysis = await analyzeExternalDependencies(tempDir, {
      calculateSize: false,
      exclude: ['lodash']
    })

    expect(analysis.totalCount).toBe(1)
    expect(analysis.dependencies.has('lodash')).toBe(false)
    expect(analysis.dependencies.has('react')).toBe(true)
    expect(analysis.excluded).toContain('lodash')
  })

  it('should exclude multiple packages', async () => {
    await createPackage('pkg-a', 'package-a', '1.0.0', { lodash: '^4.0.0', react: '^18.0.0', vue: '^3.0.0' })

    const analysis = await analyzeExternalDependencies(tempDir, {
      calculateSize: false,
      exclude: ['lodash', 'react']
    })

    expect(analysis.totalCount).toBe(1)
    expect(analysis.dependencies.has('lodash')).toBe(false)
    expect(analysis.dependencies.has('react')).toBe(false)
    expect(analysis.dependencies.has('vue')).toBe(true)
    expect(analysis.excluded).toEqual(['lodash', 'react'])
  })

  it('should not count usages of excluded packages', async () => {
    await createPackage('pkg-a', 'package-a', '1.0.0', { lodash: '^4.0.0' })
    await createPackage('pkg-b', 'package-b', '1.0.0', { lodash: '^4.0.0' })
    await createPackage('pkg-c', 'package-c', '1.0.0', { react: '^18.0.0' })

    const analysisWithExclude = await analyzeExternalDependencies(tempDir, {
      calculateSize: false,
      exclude: ['lodash']
    })

    const analysisWithoutExclude = await analyzeExternalDependencies(tempDir, {
      calculateSize: false
    })

    expect(analysisWithExclude.totalCount).toBe(1)
    expect(analysisWithoutExclude.totalCount).toBe(2)
  })

  it('should show excluded in formatted output', async () => {
    await createPackage('pkg-a', 'package-a', '1.0.0', { lodash: '^4.0.0' })

    const analysis = await analyzeExternalDependencies(tempDir, {
      calculateSize: false,
      exclude: ['lodash']
    })

    const formatted = formatExternalDependenciesAnalysis(analysis)

    expect(formatted).toContain('Excluded packages')
    expect(formatted).toContain('lodash')
  })

  it('should handle empty exclude list', async () => {
    await createPackage('pkg-a', 'package-a', '1.0.0', { lodash: '^4.0.0' })

    const analysis = await analyzeExternalDependencies(tempDir, {
      calculateSize: false,
      exclude: []
    })

    expect(analysis.totalCount).toBe(1)
    expect(analysis.excluded).toEqual([])
  })
})
