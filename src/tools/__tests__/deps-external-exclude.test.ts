import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { analyzeExternalDependencies } from '../deps.js'

describe('analyzeExternalDependencies with exclude patterns', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yama-external-exclude-'))
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

  it('should exclude by exact name', async () => {
    await createPackage('pkg-a', 'package-a', '1.0.0', { lodash: '^4.0.0', react: '^18.0.0' })

    const analysis = await analyzeExternalDependencies(tempDir, {
      calculateSize: false,
      exclude: ['lodash']
    })

    expect(analysis.totalCount).toBe(1)
    expect(analysis.dependencies.has('lodash')).toBe(false)
    expect(analysis.dependencies.has('react')).toBe(true)
    expect(analysis.excluded).toContain('lodash')
  })

  it('should exclude by glob pattern with wildcard', async () => {
    await createPackage('pkg-a', 'package-a', '1.0.0', {
      '@scope/pkg1': '^1.0.0',
      '@scope/pkg2': '^2.0.0',
      'other-pkg': '^1.0.0'
    })

    const analysis = await analyzeExternalDependencies(tempDir, {
      calculateSize: false,
      exclude: ['@scope/*']
    })

    expect(analysis.totalCount).toBe(1)
    expect(analysis.dependencies.has('@scope/pkg1')).toBe(false)
    expect(analysis.dependencies.has('@scope/pkg2')).toBe(false)
    expect(analysis.dependencies.has('other-pkg')).toBe(true)
    expect(analysis.excluded).toContain('@scope/pkg1')
    expect(analysis.excluded).toContain('@scope/pkg2')
  })

  it('should exclude by prefix pattern', async () => {
    await createPackage('pkg-a', 'package-a', '1.0.0', {
      'eslint-plugin-a': '^1.0.0',
      'eslint-plugin-b': '^2.0.0',
      'other-pkg': '^1.0.0'
    })

    const analysis = await analyzeExternalDependencies(tempDir, {
      calculateSize: false,
      exclude: ['eslint-plugin-*']
    })

    expect(analysis.totalCount).toBe(1)
    expect(analysis.dependencies.has('eslint-plugin-a')).toBe(false)
    expect(analysis.dependencies.has('eslint-plugin-b')).toBe(false)
    expect(analysis.dependencies.has('other-pkg')).toBe(true)
  })

  it('should support multiple patterns', async () => {
    await createPackage('pkg-a', 'package-a', '1.0.0', {
      lodash: '^4.0.0',
      react: '^18.0.0',
      vue: '^3.0.0',
      angular: '^15.0.0'
    })

    const analysis = await analyzeExternalDependencies(tempDir, {
      calculateSize: false,
      exclude: ['lodash', 'react', 'vue*']
    })

    expect(analysis.totalCount).toBe(1)
    expect(analysis.dependencies.has('angular')).toBe(true)
    expect(analysis.excluded).toContain('lodash')
    expect(analysis.excluded).toContain('react')
    expect(analysis.excluded).toContain('vue')
  })
})

describe('analyzeExternalDependencies with mode filter', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yama-external-mode-'))
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
    peerDeps: Record<string, string> = {}
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
        peerDependencies: peerDeps
      }, null, 2)
    )
  }

  it('should filter by prod mode', async () => {
    await createPackage('pkg-a', 'package-a', '1.0.0',
      { lodash: '^4.0.0' },
      { jest: '^29.0.0' }
    )

    const analysis = await analyzeExternalDependencies(tempDir, {
      calculateSize: false,
      mode: 'prod'
    })

    expect(analysis.totalCount).toBe(1)
    expect(analysis.dependencies.has('lodash')).toBe(true)
    expect(analysis.dependencies.has('jest')).toBe(false)
  })

  it('should filter by dev mode', async () => {
    await createPackage('pkg-a', 'package-a', '1.0.0',
      { lodash: '^4.0.0' },
      { jest: '^29.0.0' }
    )

    const analysis = await analyzeExternalDependencies(tempDir, {
      calculateSize: false,
      mode: 'dev'
    })

    expect(analysis.totalCount).toBe(1)
    expect(analysis.dependencies.has('lodash')).toBe(false)
    expect(analysis.dependencies.has('jest')).toBe(true)
  })

  it('should include all with both mode', async () => {
    await createPackage('pkg-a', 'package-a', '1.0.0',
      { lodash: '^4.0.0' },
      { jest: '^29.0.0' }
    )

    const analysis = await analyzeExternalDependencies(tempDir, {
      calculateSize: false,
      mode: 'both'
    })

    expect(analysis.totalCount).toBe(2)
    expect(analysis.dependencies.has('lodash')).toBe(true)
    expect(analysis.dependencies.has('jest')).toBe(true)
  })

  it('should include peer deps in prod mode', async () => {
    await createPackage('pkg-a', 'package-a', '1.0.0',
      { lodash: '^4.0.0' },
      { jest: '^29.0.0' },
      { react: '^18.0.0' }
    )

    const analysis = await analyzeExternalDependencies(tempDir, {
      calculateSize: false,
      mode: 'prod'
    })

    expect(analysis.totalCount).toBe(2)
    expect(analysis.dependencies.has('lodash')).toBe(true)
    expect(analysis.dependencies.has('react')).toBe(true)
    expect(analysis.dependencies.has('jest')).toBe(false)
  })
})
