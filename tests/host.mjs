import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Keep transpiler caches out of the host installation and source checkout.
process.env.JITI_FS_CACHE = 'false';
const require = createRequire(import.meta.url);
// An unpacked Pi Node installation is needed for the native-loader/SDK tests.
export const hostRoot = process.env.PI_PACKAGE_ROOT
  ? resolve(process.env.PI_PACKAGE_ROOT)
  : dirname(dirname(require.resolve('@earendil-works/pi-coding-agent')));
export const hostRequire = createRequire(join(hostRoot, 'package.json'));
export const packageRoot = fileURLToPath(new URL('../', import.meta.url));
export const extensionPath = name => join(packageRoot, 'extensions', name);
export const hostImport = path => import(pathToFileURL(join(hostRoot, path)).href);

export function blockNetwork() {
  const blocked = () => { throw new Error('Network disabled by test harness'); };
  globalThis.fetch = blocked;
  // Guard Node HTTP, HTTPS, sockets, TLS and direct undici traffic as well.
  for (const name of ['node:http', 'node:https']) {
    const mod = require(name);
    mod.request = blocked;
    mod.get = blocked;
  }
  const net = require('node:net');
  net.connect = net.createConnection = blocked;
  net.Socket.prototype.connect = blocked;
  require('node:tls').connect = blocked;
  syncBuiltinESMExports();
}
