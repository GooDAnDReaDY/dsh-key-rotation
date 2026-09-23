import { createRequire } from 'node:module';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Use an isolated, explicitly installed core. Tests never use a user's DSH home
// or credentials and never send a provider request.
export async function realCoreFixture(coreDir, version) {
  const req = createRequire(join(resolve(coreDir), 'package.json'));
  const { Context } = await import(req.resolve('@deepseek-ai/cordis'));
  const { default: Settings } = await import(req.resolve('@deepseek-ai/dsh-settings'));
  const home = mkdtempSync(join(tmpdir(), 'key-rotation-core-'));
  const copy = join(home, 'rotation');
  mkdirSync(copy);
  const source = fileURLToPath(new URL('../../', import.meta.url));
  cpSync(join(source, 'lib'), join(copy, 'lib'), { recursive: true });
  cpSync(join(source, 'package.json'), join(copy, 'package.json'));
  symlinkSync(join(resolve(coreDir), 'node_modules'), join(copy, 'node_modules'), 'junction');
  const plugin = await import(pathToFileURL(join(copy, 'lib/index.js')));
  const routes = new Map();
  const services = (ctx) => {
    ctx.provide('llm', { listProviders: () => [{ id: 'a', name: 'A' }], listConfigurableProviders: () => [] });
    ctx.provide('credentials', { resolve: async () => undefined, set: async () => {}, unset: async () => {} });
    ctx.provide('webServer', { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } });
  };
  const config = {
    persistenceEnabled: false, selfHealingIntervalMinutes: 0, webhookActionToken: 'fixture-only-private-token',
    providers: [{ provider: 'a', keys: ['KEY_A', 'KEY_B'] }],
  };
  let ctx, profile, persisted = {}, starts = 0;
  const modern = version.startsWith('0.1.7');
  if (modern) {
    const { initProfile } = await import(req.resolve('@deepseek-ai/dsh-app-boot'));
    const dir = join(home, 'profiles', 'test');
    initProfile(dir, ['test-bundle']);
    const bundle = join(dir, 'node_modules', 'test-bundle');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n');
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }));
    writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
      { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
      { id: 'dsh-key-rotation', name: 'cordis:rotation', config },
    ] }]));
    writeFileSync(join(dir, 'cordis.yml'), '[]\n');
    profile = { name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined };
  }
  const start = async () => {
    starts++;
    if (modern) {
      const { boot, readProfilePatches } = await import(req.resolve('@deepseek-ai/dsh-app-boot'));
      const { default: Editor } = await import(req.resolve('@deepseek-ai/dsh-config-editor'));
      ctx = await boot('test', join(profile.dir, 'cordis.yml'), readProfilePatches('test', profile), ctx => {
        ctx.provide('profileContext', profile);
        ctx.provide('appReady', { onReady(callback) { callback(); return () => {}; } });
        services(ctx);
        Object.assign(ctx.loader.builtins, { editor: Editor, settings: Settings, rotation: plugin });
      });
    } else {
      // Real SettingsProvider/validation/revision queue, with an in-memory disk
      // adapter. Restart reinstalls the real provider from its persisted section.
      class MemorySettings extends Settings {
        writable = true;
        async load() { return structuredClone(persisted); }
        async persist(ns, section) { persisted[ns] = structuredClone(section); }
      }
      ctx = new Context();
      services(ctx);
      await ctx.plugin(MemorySettings).await();
      await ctx.plugin(plugin, config).await();
      await ctx.fiber.await();
    }
    return ctx;
  };
  try { await start(); } catch (error) { await ctx?.fiber.dispose(); rmSync(home, { recursive: true, force: true }); throw error; }
  return {
    plugin, routes, modern, get ctx() { return ctx; }, get starts() { return starts; },
    descriptor(redact = true) { return ctx.get('settings').describe({ redactSecrets: redact }).find(row => row.ns === 'dsh-key-rotation'); },
    get persisted() { return modern ? readFileSync(profile.patchPath, 'utf8') : JSON.stringify(persisted); },
    async restart() { await ctx.fiber.dispose(); await start(); },
    async dispose() { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }); },
  };
}
