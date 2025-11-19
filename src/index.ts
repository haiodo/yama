// By Andrey Sobolev haiodo@gmail.com
import { resolve } from 'path'
import yargs, { Arguments } from 'yargs'
import { hideBin } from 'yargs/helpers'
import { listPackages } from './tools/list'
import { findSourceExports } from './tools/exports'
import { syncVersions } from './tools/sync'

console.log('Hello, Yamrm!')

yargs(hideBin(process.argv))
  .command('list <root> [mode]', 'and and list all packages in the root directory recursively',
    (yargs) => {
      return yargs.positional('root', { describe: 'a root directory for a project to list all packages.', default: '.' })
        .positional('mode', { describe: 'A display mode folder or feature', default: 'folder' })
    },
    async (argv: Arguments) => {
      const root = resolve(argv.root as string)
      await listPackages(root, argv.mode as 'feature' | 'folder')
    }
  )
  .command('find-source-exports <root>', 'and and list all packages in the root directory recursively',
    (yargs) => {
      return yargs.positional('root', { describe: 'a root directory for a project to list all packages.', default: '.' })
    },
    async (argv: Arguments) => {
      const root = resolve(argv.root as string)
      await findSourceExports(root, argv.fix as boolean)
    }
  ).option('fix', {
    alias: 'f',
    describe: 'apply fixes',
    type: 'boolean',
    default: false
  })
  .command('sync-versions <root>', 'Sync all versions to proper ones',
    (yargs) => {
      return yargs.positional('root', { describe: 'a root directory for a project to list all packages.', default: '.' })
    },
    async (argv: Arguments) => {
      const root = resolve(argv.root as string)
      await syncVersions(root)
    }
  )
  .parse()
