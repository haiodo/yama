import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { findWhereUsed, formatWhereUsedResult } from '../deps.js'

describe('findWhereUsed', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yamrm-where-used-'))
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

  describe('external dependencies', () => {
    it('should find where external dependency is used', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0', { lodash: '^4.17.0' })
      await createPackage('pkg-b', 'package-b', '1.0.0', { lodash: '^4.17.21' })

      const result = await findWhereUsed(tempDir, 'lodash')

      expect(result.found).toBe(true)
      expect(result.isInternal).toBe(false)
      expect(result.totalUsages).toBe(2)
      expect(result.externalUsages).toHaveLength(2)
      expect(result.internalUsages).toHaveLength(0)

      // Check package names
      const packageNames = result.externalUsages.map(u => u.packageName).sort()
      expect(packageNames).toEqual(['package-a', 'package-b'])
    })

    it('should distinguish dependency types', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0', { lodash: '^4.0.0' })
      await createPackage('pkg-b', 'package-b', '1.0.0', {}, { lodash: '^4.0.0' })
      await createPackage('pkg-c', 'package-c', '1.0.0', {}, {}, { lodash: '^4.0.0' })
      await createPackage('pkg-d', 'package-d', '1.0.0', {}, {}, {}, { lodash: '^4.0.0' })

      const result = await findWhereUsed(tempDir, 'lodash', 'both')

      expect(result.totalUsages).toBe(4)

      const prodUsage = result.externalUsages.find(u => u.packageName === 'package-a')
      expect(prodUsage?.type).toBe('prod')

      const devUsage = result.externalUsages.find(u => u.packageName === 'package-b')
      expect(devUsage?.type).toBe('dev')

      const peerUsage = result.externalUsages.find(u => u.packageName === 'package-c')
      expect(peerUsage?.type).toBe('peer')

      const optionalUsage = result.externalUsages.find(u => u.packageName === 'package-d')
      expect(optionalUsage?.type).toBe('optional')
    })

    it('should include package paths', async () => {
      await createPackage('packages/core', '@mono/core', '1.0.0', { lodash: '^4.0.0' })

      const result = await findWhereUsed(tempDir, 'lodash')

      expect(result.externalUsages[0].packagePath).toContain('packages/core')
      expect(result.externalUsages[0].packagePath).toContain('package.json')
    })
  })

  describe('internal dependencies', () => {
    it('should find where internal dependency is used', async () => {
      await createPackage('pkg-base', 'package-base', '1.0.0')
      await createPackage('pkg-a', 'package-a', '1.0.0', { 'package-base': 'workspace:^' })
      await createPackage('pkg-b', 'package-b', '1.0.0', { 'package-base': 'workspace:^' })

      const result = await findWhereUsed(tempDir, 'package-base')

      expect(result.found).toBe(true)
      expect(result.isInternal).toBe(true)
      expect(result.totalUsages).toBe(2)
      expect(result.internalUsages).toHaveLength(2)

      const packageNames = result.internalUsages.map(u => u.packageName).sort()
      expect(packageNames).toEqual(['package-a', 'package-b'])
    })

    it('should return empty when internal package has no dependents', async () => {
      await createPackage('pkg-standalone', 'standalone', '1.0.0')

      const result = await findWhereUsed(tempDir, 'standalone')

      expect(result.found).toBe(false)
      expect(result.isInternal).toBe(true)
      expect(result.totalUsages).toBe(0)
    })
  })

  describe('not found', () => {
    it('should return not found for non-existent package', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0')

      const result = await findWhereUsed(tempDir, 'nonexistent-package')

      expect(result.found).toBe(false)
      expect(result.totalUsages).toBe(0)
    })
  })

  describe('mode filtering', () => {
    beforeEach(async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0', { lodash: '^4.0.0' })
      await createPackage('pkg-b', 'package-b', '1.0.0', {}, { lodash: '^4.0.0' })
      await createPackage('pkg-c', 'package-c', '1.0.0', { lodash: '^4.0.0' })
    })

    it('should filter by prod mode (default)', async () => {
      const result = await findWhereUsed(tempDir, 'lodash', 'prod')

      expect(result.mode).toBe('prod')
      expect(result.totalUsages).toBe(2)
      expect(result.totalUsagesBeforeFilter).toBe(3)
      expect(result.externalUsages.every(u => u.type !== 'dev')).toBe(true)
    })

    it('should filter by dev mode', async () => {
      const result = await findWhereUsed(tempDir, 'lodash', 'dev')

      expect(result.mode).toBe('dev')
      expect(result.totalUsages).toBe(1)
      expect(result.totalUsagesBeforeFilter).toBe(3)
      expect(result.externalUsages.every(u => u.type === 'dev')).toBe(true)
    })

    it('should show all with both mode', async () => {
      const result = await findWhereUsed(tempDir, 'lodash', 'both')

      expect(result.mode).toBe('both')
      expect(result.totalUsages).toBe(3)
      expect(result.totalUsagesBeforeFilter).toBe(3)
    })

    it('should include peer and optional in prod mode', async () => {
      await createPackage('pkg-d', 'package-d', '1.0.0', {}, {}, { lodash: '^4.0.0' })
      await createPackage('pkg-e', 'package-e', '1.0.0', {}, {}, {}, { lodash: '^4.0.0' })

      const result = await findWhereUsed(tempDir, 'lodash', 'prod')

      expect(result.totalUsages).toBe(4) // prod + peer + optional
      expect(result.externalUsages.some(u => u.type === 'peer')).toBe(true)
      expect(result.externalUsages.some(u => u.type === 'optional')).toBe(true)
    })
  })

  describe('formatting', () => {
    it('should format external dependency usages', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0', { lodash: '^4.0.0' })
      await createPackage('pkg-b', 'package-b', '1.0.0', {}, { lodash: '^4.0.0' })

      const result = await findWhereUsed(tempDir, 'lodash', 'both')
      const formatted = formatWhereUsedResult(result)

      expect(formatted).toContain('lodash')
      expect(formatted).toContain('External')
      expect(formatted).toContain('package-a')
      expect(formatted).toContain('package-b')
      expect(formatted).toContain('Production')
      expect(formatted).toContain('Development')
    })

    it('should show mode in output', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0', { lodash: '^4.0.0' })

      const resultProd = await findWhereUsed(tempDir, 'lodash', 'prod')
      expect(formatWhereUsedResult(resultProd)).toContain('Production only')

      const resultDev = await findWhereUsed(tempDir, 'lodash', 'dev')
      expect(formatWhereUsedResult(resultDev)).toContain('Development only')

      const resultBoth = await findWhereUsed(tempDir, 'lodash', 'both')
      expect(formatWhereUsedResult(resultBoth)).toContain('All dependencies')
    })

    it('should show filter info when filtered', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0', { lodash: '^4.0.0' })
      await createPackage('pkg-b', 'package-b', '1.0.0', {}, { lodash: '^4.0.0' })

      const result = await findWhereUsed(tempDir, 'lodash', 'prod')
      const formatted = formatWhereUsedResult(result)

      expect(formatted).toContain('filtered from 2 total usages')
    })

    it('should format internal dependency usages', async () => {
      await createPackage('pkg-base', 'package-base', '1.0.0')
      await createPackage('pkg-a', 'package-a', '1.0.0', { 'package-base': 'workspace:^' })

      const result = await findWhereUsed(tempDir, 'package-base')
      const formatted = formatWhereUsedResult(result)

      expect(formatted).toContain('package-base')
      expect(formatted).toContain('Internal')
      expect(formatted).toContain('package-a')
    })

    it('should show not found message', async () => {
      const result = await findWhereUsed(tempDir, 'nonexistent')
      const formatted = formatWhereUsedResult(result)

      expect(formatted).toContain('nonexistent')
      expect(formatted).toContain('not found')
    })

    it('should warn about multiple versions', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0', { lodash: '^4.17.0' })
      await createPackage('pkg-b', 'package-b', '1.0.0', { lodash: '^4.17.21' })

      const result = await findWhereUsed(tempDir, 'lodash')
      const formatted = formatWhereUsedResult(result)

      expect(formatted).toContain('Multiple versions')
      expect(formatted).toContain('4.17.0')
      expect(formatted).toContain('4.17.21')
    })
  })

  describe('versions tracking', () => {
    it('should track different versions', async () => {
      await createPackage('pkg-a', 'package-a', '1.0.0', { lodash: '^4.17.0' })
      await createPackage('pkg-b', 'package-b', '1.0.0', { lodash: '^4.17.21' })

      const result = await findWhereUsed(tempDir, 'lodash')

      const versions = result.externalUsages.map(u => u.version)
      expect(versions).toContain('^4.17.0')
      expect(versions).toContain('^4.17.21')
    })
  })
})
