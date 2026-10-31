import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/types/index.ts',
  },
  format: 'esm',
  outDir: 'lib',
  dts: true,
  clean: false,
  outExtensions: () => ({ dts: '.d.ts' }),
})
