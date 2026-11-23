import { globSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type UserConfig } from 'vite';
import dts from 'vite-plugin-dts';

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

function sourceEntries(): Record<string, string> {
  return Object.fromEntries(
    globSync('src/**/*.ts', { cwd: packageRoot }).map((file) => [
      file.slice('src/'.length, -'.ts'.length),
      path.resolve(packageRoot, file),
    ]),
  );
}

/** Keep dependencies and Node built-ins external. Bundle only this package's source. */
function external(id: string): boolean {
  if (id.startsWith('\0') || id.startsWith('.')) return false;
  if (path.isAbsolute(id))
    return id.includes(`${path.sep}node_modules${path.sep}`);
  return true;
}

const library: UserConfig = {
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    target: 'es2023',
    lib: {
      entry: sourceEntries(),
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rolldownOptions: {
      external,
      output: {
        preserveModules: true,
        preserveModulesRoot: path.resolve(packageRoot, 'src'),
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
      },
    },
  },
  plugins: [
    dts({
      tsconfigPath: path.join(packageRoot, 'tsconfig.json'),
      include: ['src'],
      entryRoot: 'src',
      copyDtsFiles: true,
      bundleTypes: false,
    }),
  ],
};

export default defineConfig(({ command }) => {
  if (command === 'serve') {
    return {
      root: path.join(packageRoot, 'dev'),
      server: {
        host: '127.0.0.1',
        port: 5173,
        fs: { allow: [packageRoot] },
      },
    };
  }
  return library;
});
