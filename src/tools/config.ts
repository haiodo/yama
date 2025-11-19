import { readFile, writeFile } from 'fs/promises'
import path from 'path'
import { globby } from 'globby'
import { groupByFeature } from './group'
import yaml from 'js-yaml'
import { existsSync } from 'fs'
import { moveMessagePortToContext } from 'worker_threads'

export interface Configuration {
  categories?: string[] // User defined categories
  enabled?: string[] // Enabled features
  ignored?: string[] // Ignored features, other are ignored by default

  features?: Record<string, {
    modules: number
    enabled: boolean
    names?: string[]
  }>
  modules: number

  // A feature managed package.json's
  // Key is a pack to package.json file
  managed?: Record<string, {
    exclude?: string[]
    features?: string[]
  }>
}

export interface PackageDecl {
  name: string;
  version: string;
  file: string,
  pkg: {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
}

async function listPackage (root: string): Promise<PackageDecl[]> {
  const files = await globby(['**/package.json'], { cwd: root, gitignore: true, followSymbolicLinks: false })

  const pkgs: PackageDecl[] = []

  for (const file of files) {
    try {
      const content = await readFile(path.join(root, file), 'utf8')
      const json = JSON.parse(content)
      if (json.name && json.version) {
        pkgs.push({ name: json.name, version: json.version, file, pkg: json })
      }
    } catch {
      // ignore malformed package.json
    }
  }
  return pkgs
}

/**
 * List all packages in `root` (recursively), sorted alphabetically by name.
 */
export async function updateConfig (root: string, includePackages: boolean): Promise<void> {
  console.info('Listing packages in', root)

  const pkgs = await listPackage(root)
  const configFile = path.join(root, 'ymrm.yaml')
  let config: Configuration = {
    enabled: [],
    ignored: [], // A list of ignored features
    features: {},
    modules: 0
  }
  if (existsSync(configFile)) {
    config = yaml.load((await readFile(configFile)).toString()) as Configuration
  }

  const groupped = groupByFeature(pkgs, config.categories ?? [])

  if (config.features === undefined) {
    config.features = {}
  }

  // Remove orphaned categories
  for (const k of Object.keys(config.features ?? {})) {
    if (!groupped.has(k)) {
      delete config.features[k]
    }
  }

  const features: Record<string, PackageDecl[]> = {}
  for (const [group, pkgs] of groupped) {
    if (group === 'other' || (config.enabled ?? []).includes(group) || (config.ignored ?? []).includes(group)) {
      if (config.features[group] !== undefined) {
        delete config.features[group]
      }
      continue
    }
    if (config.features[group] === undefined) {
      config.features[group] = {
        enabled: true,
        modules: pkgs.length,
        names: pkgs.map(it => it.name)
      }
    } else {
      config.features[group].modules = pkgs.length
      config.features[group].names = pkgs.map(it => it.name)
    }
    features[group] = pkgs
    if (!includePackages) {
      delete config.features[group].names
    }
  }

  config.modules = pkgs.length

  // Collect enabled managed feature
  for (const [managed, value] of Object.entries(config.managed ?? {})) {
    const pkg = pkgs.find(it => it.name === managed)
    if (pkg == null) {
      continue
    }
    // Find a list of features
    const enabledFeatures = new Set((value ?? {}).features ?? [])

    // Add new features if found
    for (const [f, pkgs] of Object.entries(features)) {
      // Check if dependencies has required deps
      for (const p of pkgs) {
        if ((pkg.pkg.dependencies ?? {})[p.name] !== undefined) {
          // We had dependency
          enabledFeatures.add(f)
        }
      }
    }
    if (config.managed === undefined) {
      config.managed = {}
    }
    config.managed[managed] = { features: Array.from(enabledFeatures) }
  }

  // Write update config file

  await writeFile(configFile, yaml.dump(config, {
    lineWidth: -1, // Prevent line wrapping
    noRefs: true, // Avoid unnecessary references
    condenseFlow: true, // Prevent multi-line block scalars
  }))
}

/**
 * 1. Load configuration
 * 2. Check if all enabled modules are included
 */
export async function applyConfig (root: string): Promise<void> {
  console.info('Listing packages in', root)

  const pkgs = await listPackage(root)

  const configFile = path.join(root, 'ymrm.yaml')

  if (!existsSync(configFile)) {
    console.error('Failed to apply configuration changes, please create yamnm configuration first.')
    return
  }
  const config: Configuration = yaml.load((await readFile(configFile)).toString()) as Configuration
  console.log(config.modules)

  const groupped = groupByFeature(pkgs, config.categories ?? [])

  if (config.features === undefined) {
    config.features = {}
  }

  // Collect features
  const toInclude: Record<string, PackageDecl[]> = {}
  const toExclude: Record<string, PackageDecl[]> = {}

  for (const [group, pkgs] of groupped) {
    const enabled = (config.features ?? {})[group]?.enabled === true ||
      group === 'other' || (config.enabled ?? []).includes(group) || (config.ignored ?? []).includes(group)
    if (enabled) {
      toInclude[group] = pkgs
    } else {
      toExclude[group] = pkgs
    }
  }

  for (const [mgt, value] of Object.entries(config.managed ?? {})) {
    if (value == null) {
      console.warn('Could not update package, since it has no features to enable/disable')
      continue
    }
    // We need to filter
    const pkg = pkgs.find(it => it.name === mgt)
    if (pkg == null) {
      continue
    }

    const mustInclude = new Map((value.features ?? []).map(it => toInclude[it] ?? []).flat().map(it => [it.name, it]))
    const mustExclude = new Map((value.features ?? []).map(it => toExclude[it] ?? []).flat().map(it => [it.name, it]))

    // Remove excluded from managed
    for (const ex of value.exclude ?? []) {
      const toExclude = groupped.get(ex)
      for (const c of toExclude ?? []) {
        mustInclude.delete(c.name)
        mustExclude.delete(c.name)
      }
      mustInclude.delete(ex)
      mustExclude.delete(ex)
    }

    let changes = 0
    // Exclude if disabled
    pkg.pkg.dependencies = Object.fromEntries(Object.entries(pkg.pkg.dependencies ?? []).filter(it => {
      if (mustExclude.has(it[0])) {
        // We found included, feature but disabled
        changes++
        console.log('exclude disabled:', it[0])
        return false
      }
      return true
    }))
    if (pkg.pkg.dependencies == null) {
      pkg.pkg.dependencies = {}
    }
    for (const [k, _pkg] of mustInclude.entries()) {
      if (pkg.pkg.dependencies[k] == null) {
        changes++
        pkg.pkg.dependencies[k] = 'workspace:^' + _pkg.version
      }
    }
    if (changes > 0) {
      // Write package back
      await writeFile(path.join(root, pkg.file), JSON.stringify(pkg.pkg, undefined, 2))
    }
  }
}
