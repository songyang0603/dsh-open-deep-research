#!/usr/bin/env node

import { constants, realpathSync } from 'node:fs'
import { lstat, open, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command, CommanderError, Option } from 'commander'

interface ProfileManifest {
  readonly dsh?: {
    readonly profile?: {
      readonly bundles?: unknown
    }
  }
}

const PACKAGE_NAME = 'dsh-open-deep-research'
const BASE_BUNDLE = '@deepseek-ai/dsh-base'
const DEDICATED_PROFILE_BUNDLES = [BASE_BUNDLE, PACKAGE_NAME] as const

/** Optional page reader installed into the dedicated Profile. */
export type ResearchProfileReader = 'jina'

/** One-time Profile overlay selection. Omission preserves the search-only Alpha path. */
export interface ResearchProfileOverlayOptions {
  readonly reader?: ResearchProfileReader
}

function meaningfulPatch(content: string): string {
  return content
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('')
    .trim()
}

function assertDedicatedProfileBundles(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error('not a DSH Profile manifest: dsh.profile.bundles must be an array')
  }
  if (value.some((bundle) => typeof bundle !== 'string')) {
    throw new Error('refusing to initialize a Profile with a non-string bundle entry')
  }

  const bundles = value as string[]
  const exactDedicatedProfile =
    bundles.length === DEDICATED_PROFILE_BUNDLES.length &&
    DEDICATED_PROFILE_BUNDLES.every((bundle, index) => bundles[index] === bundle)
  if (!exactDedicatedProfile) {
    throw new Error(
      `refusing to initialize a non-dedicated Profile; expected exactly ${BASE_BUNDLE} followed by ${PACKAGE_NAME}`,
    )
  }
}

function sameSnapshot(
  first: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
  second: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
): boolean {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.mtimeMs === second.mtimeMs &&
    first.ctimeMs === second.ctimeMs
  )
}

async function replaceEmptyPatch(patchPath: string, overlay: string): Promise<void> {
  const pathEntry = await lstat(patchPath)
  if (pathEntry.isSymbolicLink() || !pathEntry.isFile()) {
    throw new Error(`refusing to replace a symbolic link or non-file Profile patch: ${patchPath}`)
  }

  const patch = await open(patchPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
  try {
    const initial = await patch.stat()
    if (pathEntry.dev !== initial.dev || pathEntry.ino !== initial.ino) {
      throw new Error(`the Profile patch path changed while it was being initialized: ${patchPath}`)
    }
    const currentPatch = await patch.readFile('utf8')
    if (meaningfulPatch(currentPatch) !== '[]') {
      throw new Error(
        `refusing to overwrite the existing Profile patch: ${patchPath}; merge the packaged research overlay manually`,
      )
    }

    const beforeWrite = await patch.stat()
    if (!sameSnapshot(initial, beforeWrite)) {
      throw new Error(`the Profile patch changed while it was being initialized: ${patchPath}`)
    }

    const bytes = Buffer.from(overlay)
    await patch.truncate(0)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesWritten } = await patch.write(bytes, offset, bytes.length - offset, offset)
      if (bytesWritten === 0) throw new Error(`could not write the Profile patch: ${patchPath}`)
      offset += bytesWritten
    }
    await patch.sync()

    const [written, currentPath] = await Promise.all([patch.stat(), lstat(patchPath)])
    if (
      currentPath.isSymbolicLink() ||
      !currentPath.isFile() ||
      written.dev !== currentPath.dev ||
      written.ino !== currentPath.ino ||
      written.size !== bytes.length
    ) {
      throw new Error(`the Profile patch path changed while it was being initialized: ${patchPath}`)
    }
  } finally {
    await patch.close()
  }
}

function overlayFilename(options: ResearchProfileOverlayOptions): string {
  if (options.reader === undefined) return 'research-profile.patch.yml'
  if (options.reader === 'jina') {
    if (!process.env.JINA_API_KEY?.trim()) {
      throw new Error(
        'Jina Reader Profile requires JINA_API_KEY in the launching environment; no Profile file was changed',
      )
    }
    return 'research-profile-jina.patch.yml'
  }
  throw new TypeError(`unsupported research Profile reader: ${String(options.reader)}`)
}

/** Install one dedicated app overlay only into a new, still-empty custom Profile. */
export async function installResearchProfileOverlay(
  profileDir = process.cwd(),
  options: ResearchProfileOverlayOptions = {},
): Promise<string> {
  const manifestPath = resolve(profileDir, 'package.json')
  const patchPath = resolve(profileDir, 'cordis.patch.yml')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ProfileManifest
  const bundles = manifest.dsh?.profile?.bundles
  assertDedicatedProfileBundles(bundles)

  const overlayPath = fileURLToPath(
    new URL(`../bundle/${overlayFilename(options)}`, import.meta.url),
  )
  const overlay = await readFile(overlayPath, 'utf8')
  await replaceEmptyPatch(patchPath, overlay)
  return patchPath
}

function initializerCommand(): Command {
  return new Command()
    .name('dsh-open-deep-research-init')
    .description('Install the one-shot Deep Research app into an empty dedicated DSH Profile.')
    .addOption(new Option('--reader <reader>', 'explicit page-reading provider').choices(['jina']))
    .helpOption('-h, --help', 'show this help')
}

async function main(): Promise<void> {
  const program = initializerCommand().exitOverride()
  let reader: ResearchProfileReader | undefined
  try {
    program.parse(process.argv, { from: 'node' })
    reader = program.opts<{ reader?: ResearchProfileReader }>().reader
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error
    process.exitCode = error.exitCode === 0 ? 0 : 2
    return
  }

  const patchPath = await installResearchProfileOverlay(
    process.cwd(),
    reader === undefined ? {} : { reader },
  )
  process.stdout.write(
    `Installed the Deep Research${reader === 'jina' ? ' + Jina Reader' : ''} app overlay at ${patchPath}\n`,
  )
}

const invokedPath =
  process.argv[1] === undefined ? undefined : realpathSync(resolve(process.argv[1]))
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `dsh-open-deep-research-init: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  })
}
