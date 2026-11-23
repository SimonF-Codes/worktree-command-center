// The one place a test makes its temp directory.
//
// Git canonicalises every path it records or reports: on Windows it expands 8.3 short names
// (`RUNNER~1` → `runneradmin`) and resolves junctions and symlinks. `os.tmpdir()` does neither —
// on the GitHub Windows runner it returns `C:\Users\RUNNER~1\AppData\Local\Temp`. A test that builds
// a path from the temp root and compares it with a path git reported is then comparing two
// spellings of one directory, and fails (or, worse, the code under test finds "nothing to do").
//
// `fs.realpathSync` is NOT enough: the JS implementation resolves links but keeps an 8.3 name as
// it was given. `fs.realpathSync.native` asks the OS for the final path, which is the long form —
// the same spelling git uses. On Linux and macOS it resolves symlinks (e.g. macOS's /var →
// /private/var), which is what git does there too.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** `fs.mkdtempSync` under the OS temp root, returned in its canonical (git's) spelling. */
export function makeTempDir(prefix: string): string {
	return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
