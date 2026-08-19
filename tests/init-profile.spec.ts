import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installResearchProfileOverlay } from '../src/init-profile.js'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
let profileDir: string | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  if (profileDir !== undefined) {
    await rm(profileDir, { recursive: true, force: true })
    profileDir = undefined
  }
})

async function fixture(bundles: readonly string[], patch = '# User patch\n[]\n'): Promise<string> {
  profileDir = await mkdtemp(join(tmpdir(), 'dsh-open-research-profile-'))
  await writeFile(
    join(profileDir, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-research',
      private: true,
      dsh: { profile: { bundles } },
    }),
  )
  await writeFile(join(profileDir, 'cordis.patch.yml'), patch)
  return profileDir
}

describe('research Profile initializer', () => {
  it('keeps the default bundle and search-only overlay free of Jina and unsafe HTTP fetch', async () => {
    const [defaultBundle, searchOnly] = await Promise.all([
      readFile(join(projectRoot, 'bundle/cordis.patch.yml'), 'utf8'),
      readFile(join(projectRoot, 'bundle/research-profile.patch.yml'), 'utf8'),
    ])

    for (const content of [defaultBundle, searchOnly]) {
      expect(content).not.toContain('jina')
      expect(content).not.toContain('dsh-mcp-client')
      expect(content).not.toContain('dsh-web-fetch-http')
    }
  })

  it('installs the packaged app overlay into an empty custom Profile', async () => {
    const dir = await fixture(['@deepseek-ai/dsh-base', 'dsh-open-deep-research'])
    const patchPath = await installResearchProfileOverlay(dir)
    const installed = await readFile(patchPath, 'utf8')

    expect(installed).toContain('- id: hmr\n  disabled: true')
    expect(installed).toContain("name: 'dsh-open-deep-research/app-startup'")
    expect(installed).toContain("name: 'dsh-open-deep-research/app-runner'")
  })

  it('runs through the packaged symlinked bin entry', async () => {
    const dir = await fixture(['@deepseek-ai/dsh-base', 'dsh-open-deep-research'])
    const binPath = join(dir, 'dsh-open-deep-research-init')
    await symlink(join(projectRoot, 'dist/init-profile.js'), binPath)

    const outcome = spawnSync(process.execPath, [binPath], {
      cwd: dir,
      encoding: 'utf8',
    })

    expect(outcome.status).toBe(0)
    expect(outcome.stdout).toContain('Installed the Deep Research app overlay')
    expect(outcome.stderr).toBe('')
    expect(await readFile(join(dir, 'cordis.patch.yml'), 'utf8')).toContain(
      'dsh-open-deep-research/app-runner',
    )
  })

  it('installs the explicit Jina Reader overlay without materializing its key', async () => {
    vi.stubEnv('JINA_API_KEY', 'jina_test_secret_value')
    const dir = await fixture(['@deepseek-ai/dsh-base', 'dsh-open-deep-research'])
    const patchPath = await installResearchProfileOverlay(dir, { reader: 'jina' })
    const installed = await readFile(patchPath, 'utf8')

    expect(installed).toContain("name: '@deepseek-ai/dsh-mcp-client'")
    expect(installed).toContain('include_tools=read_url&max_tokens=8000')
    expect(installed).toContain('mcp__reader__read_url')
    expect(installed).toContain('dsh-open-deep-research/jina-reader-prerequisite')
    expect(installed).toContain('ctx.jinaReaderPrerequisite.authorization')
    expect(installed).not.toContain('jina_test_secret_value')
    expect(installed).not.toContain('dsh-web-fetch-http')
  })

  it('refuses the Jina overlay without a key and leaves the empty patch unchanged', async () => {
    vi.stubEnv('JINA_API_KEY', '')
    const empty = '# User patch\n[]\n'
    const dir = await fixture(['@deepseek-ai/dsh-base', 'dsh-open-deep-research'], empty)

    await expect(installResearchProfileOverlay(dir, { reader: 'jina' })).rejects.toThrow(
      'requires JINA_API_KEY',
    )
    expect(await readFile(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(empty)
  })

  it('runs the Jina choice through the packaged bin and keeps the key out of output', async () => {
    const dir = await fixture(['@deepseek-ai/dsh-base', 'dsh-open-deep-research'])
    const binPath = join(dir, 'dsh-open-deep-research-init')
    await symlink(join(projectRoot, 'dist/init-profile.js'), binPath)

    const outcome = spawnSync(process.execPath, [binPath, '--reader', 'jina'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, JINA_API_KEY: 'jina_spawn_test_secret' },
    })

    expect(outcome.status).toBe(0)
    expect(outcome.stdout).toContain('Deep Research + Jina Reader')
    expect(outcome.stdout).not.toContain('jina_spawn_test_secret')
    expect(outcome.stderr).toBe('')
    const installed = await readFile(join(dir, 'cordis.patch.yml'), 'utf8')
    expect(installed).toContain('mcp__reader__read_url')
    expect(installed).not.toContain('jina_spawn_test_secret')
  })

  it('rejects an unknown reader without changing the patch', async () => {
    const empty = '# User patch\n[]\n'
    const dir = await fixture(['@deepseek-ai/dsh-base', 'dsh-open-deep-research'], empty)
    const binPath = join(dir, 'dsh-open-deep-research-init')
    await symlink(join(projectRoot, 'dist/init-profile.js'), binPath)

    const outcome = spawnSync(process.execPath, [binPath, '--reader', 'unknown'], {
      cwd: dir,
      encoding: 'utf8',
    })

    expect(outcome.status).toBe(2)
    expect(outcome.stderr).toContain('Allowed choices are jina')
    expect(await readFile(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(empty)
  })

  it('refuses to overwrite an existing user patch', async () => {
    const existing = '- id: research-engine\n  config:\n    maxTokens: 4096\n'
    const dir = await fixture(['@deepseek-ai/dsh-base', 'dsh-open-deep-research'], existing)

    await expect(installResearchProfileOverlay(dir)).rejects.toThrow('refusing to overwrite')
    expect(await readFile(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(existing)
  })

  it.each(['@deepseek-ai/dsh-headless', '@deepseek-ai/dsh-web-app'])(
    'refuses to compete with the stock app bundle %s',
    async (stockBundle) => {
      const dir = await fixture(['@deepseek-ai/dsh-base', stockBundle, 'dsh-open-deep-research'])

      await expect(installResearchProfileOverlay(dir)).rejects.toThrow(
        'refusing to initialize a non-dedicated Profile',
      )
    },
  )

  it.each([
    ['a missing package bundle', ['@deepseek-ai/dsh-base']],
    ['a missing base bundle', ['dsh-open-deep-research']],
    [
      'an extra third-party bundle',
      ['@deepseek-ai/dsh-base', 'dsh-open-deep-research', '@example/custom-app'],
    ],
    [
      'a duplicate bundle',
      ['@deepseek-ai/dsh-base', 'dsh-open-deep-research', 'dsh-open-deep-research'],
    ],
    ['reordered bundles', ['dsh-open-deep-research', '@deepseek-ai/dsh-base']],
  ])('refuses %s', async (_case, bundles) => {
    const dir = await fixture(bundles)

    await expect(installResearchProfileOverlay(dir)).rejects.toThrow(
      'refusing to initialize a non-dedicated Profile',
    )
  })

  it('refuses a symbolic-link patch without changing its target', async () => {
    const dir = await fixture(['@deepseek-ai/dsh-base', 'dsh-open-deep-research'])
    const patchPath = join(dir, 'cordis.patch.yml')
    const targetPath = join(dir, 'user-owned.patch.yml')
    await rm(patchPath)
    await writeFile(targetPath, '[]\n')
    await symlink(targetPath, patchPath)

    await expect(installResearchProfileOverlay(dir)).rejects.toThrow('symbolic link')
    expect(await readFile(targetPath, 'utf8')).toBe('[]\n')
  })

  it('rejects malformed bundle entries at runtime', async () => {
    const dir = await fixture(['@deepseek-ai/dsh-base', 'dsh-open-deep-research'])
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-research',
        private: true,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 42] } },
      }),
    )

    await expect(installResearchProfileOverlay(dir)).rejects.toThrow('non-string bundle entry')
  })
})
