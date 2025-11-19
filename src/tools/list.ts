import { promises as fs } from 'fs'
import path from 'path'
import { globby } from 'globby'
import { groupByFeature, groupByRoot } from './group'

/**
 * List all packages in `root` (recursively), sorted alphabetically by name.
 */
export async function listPackages (root: string, showBy: 'folder' | 'feature' = 'folder'): Promise<void> {
  console.info('Listing packages in', root)
  const files = await globby(['**/package.json'], { cwd: root, gitignore: true, followSymbolicLinks: false })

  console.log('found', files.length)
  const pkgs: { name: string; version: string; file: string }[] = []

  for (const file of files) {
    try {
      const content = await fs.readFile(path.join(root, file), 'utf8')
      const json = JSON.parse(content)
      if (json.name && json.version) {
        pkgs.push({ name: json.name, version: json.version, file })
      }
    } catch {
      // ignore malformed package.json
    }
  }

  switch (showBy) {
    case 'folder': {
      const groupped = groupByRoot(pkgs)

      for (const [group, pkgs] of groupped) {
        console.log(group)
        pkgs.sort((a, b) => a.name.localeCompare(b.name))
        for (const pkg of pkgs) {
          console.info(`\t${pkg.name}@${pkg.version} (${path.relative(group, pkg.file)})`)
        }
      }
      break
    }
    case 'feature':
    {
      const groupped = groupByFeature(pkgs)

      for (const [group, pkgs] of groupped) {
        console.log(group)
        pkgs.sort((a, b) => a.name.localeCompare(b.name))
        for (const pkg of pkgs) {
          console.info(`\t${pkg.name}@${pkg.version} (${path.relative(group, pkg.file)})`)
        }
      }
    }
  }
}
