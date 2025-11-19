import path from 'path'

export function groupByRoot<T extends { file: string } > (
  pkgs: T[]
): Map<string, Array<T>> {
  const map: Map<string, Array<T>> = new Map()
  if (pkgs.length === 1) {
    map.set(path.dirname(pkgs[0].file), pkgs)
    return map
  }

  // Find a common root's for packages
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

export function groupByFeature<T extends { name: string } > (
  pkgs: T[],
  categories?: string[]
): Map<string, Array<T>> {
  const map: Map<string, Array<T>> = new Map()

  function addTo (root: string, pkg: T): void {
    if (!map.has(root)) {
      map.set(root, [])
    }
    map.get(root)!.push(pkg)
  }

  // Find a common root's for packages
  for (const pkg of pkgs) {
    let name = pkg.name
    const revReplace: Record<string, string> = {}
    for (const udc of categories ?? []) {
      const u = '%{' + udc.replaceAll('/', '_').replaceAll('-', '_') + '}'
      name = name.replaceAll(udc, u)
      revReplace[u] = udc
    }
    const segments = (name.split('/')).map(it => it.split('-')).flat().map(it => {
      return revReplace[it] ?? it
    })
    // Join segments if they match categories

    for (const root of segments) {
      addTo(root, pkg)
    }
  }
  // Combine all single into a other category.
  for (const [c, pkgs] of [...map.entries()]) {
    if (pkgs.length === 1) {
      addTo('other', pkgs[0])
      map.delete(c)
    }
  }

  return map
}
