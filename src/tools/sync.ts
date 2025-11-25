import { promises as fs } from 'fs'
import path from 'path'
import { globby } from 'globby'

function parseVersion (version: string): number[] {
  if (version.startsWith('workspace:')) {
    version = version.slice(10)
  }
  if (version.startsWith('^') || version.startsWith('~')) {
    version = version.slice(1)
  }
  const [major, minor, patch] = version.split('.')
  return [Number(major), Number(minor), Number(patch)]
}
function compareVersions (v1: string, v2: string): number {
  const [major1, minor1, patch1] = parseVersion(v1)
  const [major2, minor2, patch2] = parseVersion(v2)
  if (major1 !== major2) return major1 - major2
  if (minor1 !== minor2) return minor1 - minor2
  return patch1 - patch2
}
/**
 * Find all dependencies in all packages, and update to latest versions of dependencies specified.
 */
export async function syncVersions (root: string): Promise<void> {
  console.info('Listing packages in', root)
  const files = await globby(['**/package.json'], { cwd: root, gitignore: true, followSymbolicLinks: false })

  console.log('found', files.length)
  const pkgs: {
    name: string
    version: string
    file: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pkg: Record<string, any>
  }[] = []

  const workspacePackages = new Set<string>()

  const dependencyVersions = new Map<string, string>()
  for (const file of files) {
    try {
      console.log('checking', file)
      const absFile = path.join(root, file)
      const content = await fs.readFile(absFile, 'utf8')
      const json = JSON.parse(content)

      workspacePackages.add(json.name)

      // Add package version
      // Check if have greater version
      const currentVersion = dependencyVersions.get(json.name)
      if (currentVersion == null || compareVersions(json.version as string, currentVersion) > 0) {
        dependencyVersions.set(json.name, '^' + json.version as string)
        if (currentVersion != null) {
          console.log('found new version', json.name, json.version, currentVersion)
        }
      }

      // Iterate over all deps and find the latest version of each dependency
      for (const [name, version] of Object.entries(json.dependencies ?? {})) {
        // Check if have greater version
        const currentVersion = dependencyVersions.get(name)
        if (currentVersion == null || compareVersions(version as string, currentVersion) > 0 ||
          ((version as string).startsWith('^') && !(currentVersion as string).startsWith('^'))) {
          dependencyVersions.set(name, version as string)
          if (currentVersion != null) {
            console.log('found new version', name, version, currentVersion)
          }
        }
      }
      for (const [name, version] of Object.entries(json.devDependencies ?? {})) {
        // Check if have greater version
        const currentVersion = dependencyVersions.get(name)
        if (currentVersion == null || compareVersions(version as string, currentVersion) > 0 ||
          ((version as string).startsWith('^') && !(currentVersion as string).startsWith('^'))) {
          dependencyVersions.set(name, version as string)
          if (currentVersion != null) {
            console.log('found new version', name, version, currentVersion)
          }
        }
      }

      pkgs.push({
        name: json.name,
        version: json.version,
        file: absFile,
        pkg: json
      })
    } catch {
      // ignore malformed package.json
    }
  }
  // Ok we need new iteration to update missing versions
  for (const pkg of pkgs) {
    const { dependencies, devDependencies } = pkg.pkg
    let changes = 0
    for (const [name, version] of Object.entries(dependencies ?? {})) {
      const currentVersion = dependencyVersions.get(name)
      if (currentVersion == null || compareVersions(currentVersion, version as string)) {
        dependencies[name] = currentVersion
        changes++
      }
      // Check if version starts with workspace:
      if (workspacePackages.has(name) && !dependencies[name].startsWith('workspace:')) {
        dependencies[name] = 'workspace:' + dependencies[name]
        changes++
      }
    }
    for (const [name, version] of Object.entries(devDependencies ?? {})) {
      const currentVersion = dependencyVersions.get(name)
      if (currentVersion == null || compareVersions(currentVersion, version as string)) {
        devDependencies[name] = currentVersion
        changes++
      }
      // Check if version starts with workspace:
      if (workspacePackages.has(name) && !devDependencies[name].startsWith('workspace:')) {
        devDependencies[name] = 'workspace:' + devDependencies[name]
        changes++
      }
    }
    if (changes) {
      console.log('update', pkg.file)
      pkg.pkg.dependencies = dependencies ?? {}
      pkg.pkg.devDependencies = devDependencies ?? {}
      if (Object.keys(pkg.pkg.dependencies).length === 0) {
        delete pkg.pkg.dependencies
      }
      if (Object.keys(pkg.pkg.devDependencies).length === 0) {
        delete pkg.pkg.devDependencies
      }
      await fs.writeFile(pkg.file, JSON.stringify(pkg.pkg, null, 2) + '\n')
    }
  }
}
