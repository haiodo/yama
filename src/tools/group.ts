import path from 'path'

export function groupByRoot<T extends { file: string } > (
  pkgs: T[]
): Map<string, Array<T>> {
  const map: Map<string, Array<T>> = new Map()
  if (pkgs.length === 1) {
    map.set(path.dirname(pkgs[0].file), pkgs)
    return map
  }

  // Find a common root's for pacakges
  for (const pkg of pkgs) {
    let root = path.dirname(pkg.file)

    // Find a common root
    while (pkgs.filter(it => it.file.startsWith(root + path.sep)).length === 1) {
      root = path.dirname(root)
    }
    if (!map.has(root)) {
      map.set(root, [])
    }
    map.get(root)!.push(pkg)
  }

  return map
}
