import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import {
  buildDependencyTree,
  formatDependencyTree,
  getTransitiveDependencies,
  getTransitiveDependents
} from '../deps.js'
import type { DependencyTree } from '../types.js'

describe('buildDependencyTree', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yamrm-test-'))
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

  describe('basic functionality', () => {
    it('should return empty tree for empty directory', async () => {
      const tree = await buildDependencyTree(tempDir)

      expect(tree.root).toBe(tempDir)
      expect(tree.packages.size).toBe(0)
      expect(tree.edges).toHaveLength(0)
      expect(tree.buildOrder).toHaveLength(0)
    })

    it('should load single package without dependencies', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0')

      const tree = await buildDependencyTree(tempDir)

      expect(tree.packages.size).toBe(1)
      expect(tree.packages.has('package-a')).toBe(true)
      expect(tree.roots).toHaveLength(1)
      expect(tree.leaves).toHaveLength(1)
      expect(tree.buildOrder).toEqual(['package-a'])
    })

    it('should load multiple packages without dependencies', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0')
      await createPackage('pkg-b', 'package-b', '2.0.0')
      await createPackage('pkg-c', 'package-c', '3.0.0')

      const tree = await buildDependencyTree(tempDir)

      expect(tree.packages.size).toBe(3)
      expect(tree.roots).toHaveLength(3)
      expect(tree.leaves).toHaveLength(3)
      expect(tree.edges).toHaveLength(0)
    })
  })

  describe('dependency resolution', () => {
    it('should detect simple dependency', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0')
      await createPackage('pkg-b', 'package-b', '1.0.0', { 'package-a': '^1.0.0' })

      const tree = await buildDependencyTree(tempDir)

      expect(tree.packages.size).toBe(2)
      expect(tree.edges).toHaveLength(1)
      expect(tree.edges[0]).toMatchObject({
        from: 'package-b',
        to: 'package-a',
        type: 'dependencies'
      })
    })

    it('should detect workspace dependencies', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0')
      await createPackage('pkg-b', 'package-b', '1.0.0', { 'package-a': 'workspace:^' })

      const tree = await buildDependencyTree(tempDir)

      expect(tree.edges[0].isWorkspace).toBe(true)
    })

    it('should detect dev dependencies', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0')
      await createPackage('pkg-b', 'package-b', '1.0.0', {}, { 'package-a': '^1.0.0' })

      const tree = await buildDependencyTree(tempDir)

      expect(tree.edges[0].type).toBe('devDependencies')
    })

    it('should build correct topology for chain', async () => {
      // a -> b -> c (a depends on b, b depends on c)
      await createPackage('pkg-c', 'package-c', '1.0.0')
      await createPackage('pkg-b', 'package-b', '1.0.0', { 'package-c': '^1.0.0' })
      await createPackage('pkg-a', 'package-a', '1.0.0', { 'package-b': '^1.0.0' })

      const tree = await buildDependencyTree(tempDir)

      expect(tree.buildOrder.indexOf('package-c')).toBeLessThan(tree.buildOrder.indexOf('package-b'))
      expect(tree.buildOrder.indexOf('package-b')).toBeLessThan(tree.buildOrder.indexOf('package-a'))
    })

    it('should build correct topology for diamond', async () => {
      //     a
      //    / \
      //   b   c
      //    \ /
      //     d
      await createPackage('pkg-d', 'package-d', '1.0.0')
      await createPackage('pkg-b', 'package-b', '1.0.0', { 'package-d': '^1.0.0' })
      await createPackage('pkg-c', 'package-c', '1.0.0', { 'package-d': '^1.0.0' })
      await createPackage('pkg-a', 'package-a', '1.0.0', { 'package-b': '^1.0.0', 'package-c': '^1.0.0' })

      const tree = await buildDependencyTree(tempDir)

      expect(tree.buildOrder.indexOf('package-d')).toBeLessThan(tree.buildOrder.indexOf('package-b'))
      expect(tree.buildOrder.indexOf('package-d')).toBeLessThan(tree.buildOrder.indexOf('package-c'))
      expect(tree.buildOrder.indexOf('package-b')).toBeLessThan(tree.buildOrder.indexOf('package-a'))
      expect(tree.buildOrder.indexOf('package-c')).toBeLessThan(tree.buildOrder.indexOf('package-a'))
    })
  })

  describe('circular dependencies', () => {
    it('should detect simple circular dependency', async () => {
      // a -> b -> a
      await createPackage('pkg-a', 'package-a', '1.0.0', { 'package-b': '^1.0.0' })
      await createPackage('pkg-b', 'package-b', '1.0.0', { 'package-a': '^1.0.0' })

      const tree = await buildDependencyTree(tempDir)

      expect(tree.cycles.length).toBeGreaterThan(0)
      // Проверяем что цикл содержит оба пакета
      const cycle = tree.cycles[0]
      expect(cycle).toContain('package-a')
      expect(cycle).toContain('package-b')
    })

    it('should detect complex circular dependency', async () => {
      // a -> b -> c -> a
      await createPackage('pkg-a', 'package-a', '1.0.0', { 'package-b': '^1.0.0' })
      await createPackage('pkg-b', 'package-b', '1.0.0', { 'package-c': '^1.0.0' })
      await createPackage('pkg-c', 'package-c', '1.0.0', { 'package-a': '^1.0.0' })

      const tree = await buildDependencyTree(tempDir)

      expect(tree.cycles.length).toBeGreaterThan(0)
      const cycle = tree.cycles[0]
      expect(cycle).toContain('package-a')
      expect(cycle).toContain('package-b')
      expect(cycle).toContain('package-c')
    })
  })

  describe('roots and leaves', () => {
    it('should correctly identify roots (no internal deps)', async () => {
      // Roots: c, d (no internal deps)
      // Leaves: a (nothing depends on it)
      await createPackage('pkg-d', 'package-d', '1.0.0')
      await createPackage('pkg-c', 'package-c', '1.0.0')
      await createPackage('pkg-b', 'package-b', '1.0.0', { 'package-c': '^1.0.0', 'package-d': '^1.0.0' })
      await createPackage('pkg-a', 'package-a', '1.0.0', { 'package-b': '^1.0.0' })

      const tree = await buildDependencyTree(tempDir)

      const rootNames = tree.roots.map(r => r.package.name).sort()
      expect(rootNames).toEqual(['package-c', 'package-d'])
    })

    it('should correctly identify leaves (no dependents)', async () => {
      await createPackage('pkg-d', 'package-d', '1.0.0')
      await createPackage('pkg-c', 'package-c', '1.0.0')
      await createPackage('pkg-b', 'package-b', '1.0.0', { 'package-c': '^1.0.0', 'package-d': '^1.0.0' })
      await createPackage('pkg-a', 'package-a', '1.0.0', { 'package-b': '^1.0.0' })

      const tree = await buildDependencyTree(tempDir)

      const leafNames = tree.leaves.map(r => r.package.name)
      expect(leafNames).toContain('package-a')
    })
  })

  describe('transitive dependencies', () => {
    let tree: DependencyTree

    beforeEach(async () => {
      // d -> c -> b -> a
      //      c -> e
      await createPackage('pkg-a', 'package-a', '1.0.0')
      await createPackage('pkg-e', 'package-e', '1.0.0')
      await createPackage('pkg-b', 'package-b', '1.0.0', { 'package-a': '^1.0.0' })
      await createPackage('pkg-c', 'package-c', '1.0.0', { 'package-b': '^1.0.0', 'package-e': '^1.0.0' })
      await createPackage('pkg-d', 'package-d', '1.0.0', { 'package-c': '^1.0.0' })

      tree = await buildDependencyTree(tempDir)
    })

    it('should get transitive dependencies', () => {
      const deps = getTransitiveDependencies(tree, 'package-d')

      expect(deps.has('package-c')).toBe(true)
      expect(deps.has('package-b')).toBe(true)
      expect(deps.has('package-a')).toBe(true)
      expect(deps.has('package-e')).toBe(true)
    })

    it('should get transitive dependents', () => {
      const dependents = getTransitiveDependents(tree, 'package-a')

      expect(dependents.has('package-b')).toBe(true)
      expect(dependents.has('package-c')).toBe(true)
      expect(dependents.has('package-d')).toBe(true)
      expect(dependents.has('package-e')).toBe(false)
    })

    it('should exclude dev dependencies by default', () => {
      const deps = getTransitiveDependencies(tree, 'package-d')
      expect(deps.has('package-dev')).toBe(false)
    })
  })

  describe('formatting', () => {
    it('should format tree without errors', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0')
      await createPackage('pkg-b', 'package-b', '1.0.0', { 'package-a': '^1.0.0' })

      const tree = await buildDependencyTree(tempDir)
      const formatted = formatDependencyTree(tree)

      expect(formatted).toContain('package-a')
      expect(formatted).toContain('package-b')
      expect(formatted).toContain('Build Order:')
      expect(formatted).toContain('Dependency Tree:')
    })

    it('should show cycles in format', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0', { 'package-b': '^1.0.0' })
      await createPackage('pkg-b', 'package-b', '1.0.0', { 'package-a': '^1.0.0' })

      const tree = await buildDependencyTree(tempDir)
      const formatted = formatDependencyTree(tree)

      expect(formatted).toContain('CIRCULAR DEPENDENCIES')
    })
  })

  describe('error handling', () => {
    it('should handle malformed package.json', async () => {
      const pkgDir = path.join(tempDir, 'bad-pkg')
      await fs.mkdir(pkgDir, { recursive: true })
      await fs.writeFile(path.join(pkgDir, 'package.json'), 'not valid json')

      await createPackage('pkg-a', 'package-a', '1.0.0')

      const tree = await buildDependencyTree(tempDir)

      expect(tree.packages.size).toBe(1)
      expect(tree.errors.length).toBe(1)
      expect(tree.errors[0].file).toContain('bad-pkg')
    })

    it('should handle package without name', async () => {
      const pkgDir = path.join(tempDir, 'bad-pkg')
      await fs.mkdir(pkgDir, { recursive: true })
      await fs.writeFile(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ version: '1.0.0' })
      )

      await createPackage('pkg-a', 'package-a', '1.0.0')

      const tree = await buildDependencyTree(tempDir)

      expect(tree.packages.size).toBe(1)
      expect(tree.errors.length).toBe(1)
    })

    it('should ignore external dependencies', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0', { lodash: '^4.0.0' })

      const tree = await buildDependencyTree(tempDir)

      expect(tree.packages.size).toBe(1)
      expect(tree.edges).toHaveLength(0)
    })
  })

  describe('complex scenarios', () => {
    it('should handle monorepo-like structure', async () => {
      // packages/core
      // packages/utils
      // packages/ui (depends on core, utils)
      // packages/app (depends on ui)
      await createPackage('packages/core', '@mono/core', '1.0.0')
      await createPackage('packages/utils', '@mono/utils', '1.0.0')
      await createPackage('packages/ui', '@mono/ui', '1.0.0', {
        '@mono/core': 'workspace:^',
        '@mono/utils': 'workspace:^'
      })
      await createPackage('packages/app', '@mono/app', '1.0.0', {
        '@mono/ui': 'workspace:^'
      })

      const tree = await buildDependencyTree(tempDir)

      expect(tree.packages.size).toBe(4)
      expect(tree.edges.filter(e => e.isWorkspace).length).toBe(3)

      // Check build order
      const coreIdx = tree.buildOrder.indexOf('@mono/core')
      const utilsIdx = tree.buildOrder.indexOf('@mono/utils')
      const uiIdx = tree.buildOrder.indexOf('@mono/ui')
      const appIdx = tree.buildOrder.indexOf('@mono/app')

      expect(coreIdx).toBeLessThan(uiIdx)
      expect(utilsIdx).toBeLessThan(uiIdx)
      expect(uiIdx).toBeLessThan(appIdx)
    })
  })
})
