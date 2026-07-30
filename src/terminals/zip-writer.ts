/** A minimal, dependency-free ZIP writer (deflate, no ZIP64).
 *
 *  We archive stale worktrees as .zip so the folders can be deleted without losing the work, and
 *  this app ships no compression dependency — node's `zlib` plus ~100 lines of container format is
 *  cheaper (and more portable) than shelling out to `Compress-Archive` on Windows / `zip` on mac,
 *  which behave differently and aren't guaranteed present. Pure in/out: entries → Buffer, so it
 *  unit-tests without touching the filesystem.
 *
 *  Deliberately NOT ZIP64: sizes and offsets are 32-bit, entry count is 16-bit. buildZip throws if
 *  a payload would overflow those fields rather than emitting a silently-corrupt archive — see
 *  ZIP_MAX_TOTAL_BYTES / ZIP_MAX_ENTRIES. Worktree archives hold only git-visible files (no
 *  node_modules, no .git), so real archives land orders of magnitude under the caps.
 */

import { deflateRawSync } from 'zlib';

export interface ZipEntry {
	/** Path inside the archive. Always stored with forward slashes. */
	name: string;
	data: Buffer;
	/** Modification time stamped into the entry. Defaults to now. */
	mtime?: Date;
}

export const ZIP_MAX_TOTAL_BYTES = 0xffffffff; // 4 GiB − 1: the 32-bit size/offset ceiling
export const ZIP_MAX_ENTRIES = 0xffff;         // 16-bit entry count in the end-of-central-directory

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const FLAG_UTF8 = 0x0800; // bit 11: names/comments are UTF-8, not the legacy code page
const VERSION = 20;       // 2.0 — the minimum that understands deflate

const CRC_TABLE = (() => {
	const t = new Int32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[i] = c;
	}
	return t;
})();

/** Standard (PKZIP/gzip) CRC-32 of a buffer, as an unsigned 32-bit number. */
export function crc32(buf: Buffer): number {
	let c = -1;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

/** Normalize an archive member name: forward slashes, no leading slash, no `.`/`..` segments.
 *  Keeps a hostile or Windows-shaped path from escaping the extraction root ("zip slip"). */
export function zipEntryName(name: string): string {
	const parts = String(name).replace(/\\/g, '/').split('/');
	const out: string[] = [];
	for (const p of parts) {
		if (!p || p === '.' || p === '..') continue;
		out.push(p);
	}
	return out.join('/');
}

/** DOS date/time pair (2-second resolution) for a Date. Clamped to the 1980 epoch floor. */
export function dosDateTime(d: Date): { time: number; date: number } {
	const year = Math.max(1980, d.getFullYear());
	const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
	const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
	return { time, date };
}

/** Deflate unless it makes the payload bigger (tiny/incompressible files), in which case store. */
function compress(data: Buffer): { method: number; body: Buffer } {
	if (data.length === 0) return { method: METHOD_STORE, body: data };
	try {
		const body = deflateRawSync(data, { level: 9 });
		return body.length < data.length ? { method: METHOD_DEFLATE, body } : { method: METHOD_STORE, body: data };
	} catch {
		return { method: METHOD_STORE, body: data }; // never fail the archive over compression
	}
}

/** Build a complete .zip as one Buffer. Throws on the 32-bit/16-bit limits (see module note). */
export function buildZip(entries: ZipEntry[], now: Date = new Date()): Buffer {
	if (entries.length > ZIP_MAX_ENTRIES) {
		throw new Error(`too many files for a non-ZIP64 archive (${entries.length} > ${ZIP_MAX_ENTRIES})`);
	}
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;

	for (const e of entries) {
		const name = zipEntryName(e.name);
		if (!name) continue; // an entry that normalizes away has no place in the archive
		const nameBuf = Buffer.from(name, 'utf8');
		const { method, body } = compress(e.data);
		const { time, date } = dosDateTime(e.mtime ?? now);
		const crc = crc32(e.data);

		if (e.data.length > ZIP_MAX_TOTAL_BYTES || body.length > ZIP_MAX_TOTAL_BYTES) {
			throw new Error(`"${name}" is too large for a non-ZIP64 archive`);
		}

		const local = Buffer.alloc(30 + nameBuf.length);
		local.writeUInt32LE(SIG_LOCAL, 0);
		local.writeUInt16LE(VERSION, 4);
		local.writeUInt16LE(FLAG_UTF8, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(time, 10);
		local.writeUInt16LE(date, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(e.data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28); // no extra field
		nameBuf.copy(local, 30);

		const central = Buffer.alloc(46 + nameBuf.length);
		central.writeUInt32LE(SIG_CENTRAL, 0);
		central.writeUInt16LE(VERSION, 4);  // version made by
		central.writeUInt16LE(VERSION, 6);  // version needed
		central.writeUInt16LE(FLAG_UTF8, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt16LE(time, 12);
		central.writeUInt16LE(date, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(e.data.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt16LE(0, 30); // extra len
		central.writeUInt16LE(0, 32); // comment len
		central.writeUInt16LE(0, 34); // disk number start
		central.writeUInt16LE(0, 36); // internal attrs
		central.writeUInt32LE(0o644 << 16, 38); // external attrs: regular file, rw-r--r--
		central.writeUInt32LE(offset, 42);
		nameBuf.copy(central, 46);

		locals.push(local, body);
		centrals.push(central);
		offset += local.length + body.length;
		if (offset > ZIP_MAX_TOTAL_BYTES) throw new Error('archive exceeds the 4 GiB non-ZIP64 limit');
	}

	const centralSize = centrals.reduce((n, b) => n + b.length, 0);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(SIG_EOCD, 0);
	eocd.writeUInt16LE(0, 4); // this disk
	eocd.writeUInt16LE(0, 6); // disk with the central directory
	eocd.writeUInt16LE(centrals.length, 8);
	eocd.writeUInt16LE(centrals.length, 10);
	eocd.writeUInt32LE(centralSize, 12);
	eocd.writeUInt32LE(offset, 16);
	eocd.writeUInt16LE(0, 20); // no archive comment

	return Buffer.concat([...locals, ...centrals, eocd]);
}
