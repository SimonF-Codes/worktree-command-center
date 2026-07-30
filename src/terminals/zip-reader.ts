/** The read side of zip-writer.ts — enough ZIP parsing to extract an archive we wrote.
 *
 *  Reviving an archived worktree means putting its files back, so the writer needs a matching
 *  reader. Same constraints: no dependencies, no ZIP64. Parses the central directory (the
 *  authoritative index) rather than scanning local headers, so a truncated tail is detected
 *  instead of silently yielding half an archive.
 */

import { inflateRawSync } from 'zlib';
import { crc32, zipEntryName } from './zip-writer';

const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_LOCAL = 0x04034b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

export interface ReadEntry {
	name: string;
	data: Buffer;
}

/** Byte offset of the end-of-central-directory record, or -1. Scans backwards from the tail
 *  (the record is last, but a trailing comment can pad it by up to 64 KiB). */
export function findEocd(buf: Buffer): number {
	const min = Math.max(0, buf.length - 0xffff - 22);
	for (let i = buf.length - 22; i >= min; i--) {
		if (buf.readUInt32LE(i) === SIG_EOCD) return i;
	}
	return -1;
}

/** The names an archive holds, without inflating any payload — cheap enough to call on a listing. */
export function listZipNames(buf: Buffer): string[] {
	const eocd = findEocd(buf);
	if (eocd < 0) return [];
	const count = buf.readUInt16LE(eocd + 10);
	let p = buf.readUInt32LE(eocd + 16);
	const names: string[] = [];
	for (let i = 0; i < count; i++) {
		if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) break;
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		names.push(buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'));
		p += 46 + nameLen + extraLen + commentLen;
	}
	return names;
}

/** Extract every entry. Throws if the archive isn't readable; skips (rather than throws on) an
 *  individual entry whose payload is corrupt, so one bad file can't cost you the whole revive. */
export function readZip(buf: Buffer): ReadEntry[] {
	const eocd = findEocd(buf);
	if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');
	const count = buf.readUInt16LE(eocd + 10);
	let p = buf.readUInt32LE(eocd + 16);
	const out: ReadEntry[] = [];

	for (let i = 0; i < count; i++) {
		if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) {
			throw new Error('zip central directory is truncated or corrupt');
		}
		const method = buf.readUInt16LE(p + 10);
		const crc = buf.readUInt32LE(p + 16);
		const csize = buf.readUInt32LE(p + 20);
		const usize = buf.readUInt32LE(p + 24);
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const localOff = buf.readUInt32LE(p + 42);
		const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
		p += 46 + nameLen + extraLen + commentLen;

		// Directory entries (trailing slash) carry no payload — nothing to extract.
		if (name.endsWith('/')) continue;

		try {
			if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== SIG_LOCAL) continue;
			// The local header's own name/extra lengths locate the payload; they can legitimately
			// differ from the central directory's extra field, so never reuse extraLen here.
			const lNameLen = buf.readUInt16LE(localOff + 26);
			const lExtraLen = buf.readUInt16LE(localOff + 28);
			const start = localOff + 30 + lNameLen + lExtraLen;
			const body = buf.subarray(start, start + csize);
			const data = method === METHOD_DEFLATE ? inflateRawSync(body)
				: method === METHOD_STORE ? Buffer.from(body)
				: null;
			if (!data) continue;                        // unsupported method — skip, don't fail
			if (data.length !== usize) continue;        // header disagrees with payload
			if (crc32(data) !== crc) continue;          // corrupt payload
			out.push({ name: zipEntryName(name), data });
		} catch {
			continue; // one unreadable entry must not abort the extraction
		}
	}
	return out;
}
