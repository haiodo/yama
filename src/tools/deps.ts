// A module for dependency tree of all dependencies in package.json files in a selected root.

export interface DependencyMap {
  root: string
}

export async function buildDependencyTree (root: string): Promise<DependencyMap> {
  return { root }
}
