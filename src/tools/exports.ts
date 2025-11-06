import { promises as fs } from 'fs'
import path from 'path'
import { globby } from 'globby'
import { groupByRoot } from './group'

/**
 * Find all source exports in package.json files.
 */
export async function findSourceExports (root: string, fix: boolean = false): Promise<void> {
  console.info('Listing packages in', root)
  const files = await globby(['**/package.json'], { cwd: root, gitignore: true, followSymbolicLinks: false })

  console.log('found', files.length)
  const pkgs: { name: string; version: string; file: string, exports: string[] }[] = []

  const possibleExportNames = ['main', 'module', 'browser', 'svelte', 'export', 'import']
  for (const file of files) {
    try {
      const content = await fs.readFile(path.join(root, file), 'utf8')
      const json = JSON.parse(content)
      const exports: string[] = []
      let fixed = false
      for (const imp of possibleExportNames) {
        const value = json[imp]
        if (value !== undefined && value.includes('.ts')) {
          exports.push(value)
        }
        if (value.includes('.js') && fix) {
          fixed = true
          for (const imp2 of possibleExportNames) {
            if (imp2 !== imp) {
              delete json[imp2]
            }
          }
          break
        }
      }
      if (fixed) {
        await fs.writeFile(path.join(root, file), JSON.stringify(json, null, 2) + '\n')
        console.log('Fixed', file)
      }
      if (json.name && json.version && exports.length > 0) {
        pkgs.push({ name: json.name, version: json.version, file, exports })
      }
    } catch {
      // ignore malformed package.json
    }
  }

  const groupped = groupByRoot(pkgs)

  for (const [group, pkgs] of groupped) {
    console.log(group)
    pkgs.sort((a, b) => a.name.localeCompare(b.name))
    for (const pkg of pkgs) {
      console.info(`\t${pkg.name}@${pkg.version} (${path.relative(group, pkg.file)} (${pkg.exports.join(', ')}))`)
    }
  }
}
