// No generated JS, tsconfig, node_modules, or declaration files are written.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import { hostRoot, hostRequire, packageRoot } from './host.mjs';

const require = createRequire(import.meta.url);
const ts = require(process.env.PI_TYPESCRIPT_PATH || 'typescript');
const manifest = JSON.parse(fs.readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const paths = {};
for (const name of Object.keys(manifest.peerDependencies)) {
  paths[name] = [name === '@earendil-works/pi-coding-agent'
    ? join(hostRoot, 'dist/index.d.ts')
    : hostRequire.resolve(name).replace(/\.mjs$/, '.d.mts').replace(/\.js$/, '.d.ts')];
}
const nodeTypes = process.env.PI_NODE_TYPES || dirname(hostRequire.resolve('@types/node/package.json'));
const options = {
  noEmit: true, strict: true, skipLibCheck: true, allowImportingTsExtensions: true,
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, paths,
  types: ['node'], typeRoots: [dirname(nodeTypes)],
};
const files = manifest.pi.extensions.map(p => join(packageRoot, p));
const program = ts.createProgram(files, options);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => packageRoot, getCanonicalFileName: f => f, getNewLine: () => '\n',
  }));
  process.exitCode = 1;
} else console.log(`Strict TypeScript check passed for ${files.length} extensions and imported helpers.`);
