import type { Terminal } from '@xterm/xterm';

/** Decode an OSC 52 payload (the part after the `52;` identifier — i.e. `Ps;Pd`)
 *  into the text a WRITE requests, or null when there's nothing to write.
 *
 *  OSC 52 format is `52 ; <selection> ; <base64>`. We only honor writes:
 *   - `?` as the data is a READ/query — refuse it (null) so a TUI app can't
 *     exfiltrate the host clipboard back into itself.
 *   - malformed / empty / non-base64 → null (ignored).
 *  The base64 encodes UTF-8 bytes, so decode via Latin-1 → bytes → UTF-8. */
export function decodeOsc52(data: string): string | null {
	const semi = data.indexOf(';');
	if (semi < 0) return null;                 // no `Ps;Pd` split → malformed
	const payload = data.slice(semi + 1);
	if (payload === '' || payload === '?') return null; // empty or read/query
	try {
		const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
		const text = new TextDecoder().decode(bytes);
		return text || null;
	} catch {
		return null;                             // not valid base64
	}
}

/** Wire OSC 52 clipboard-write support into an xterm terminal. The Claude TUI emits
 *  `ESC ] 52 ; c ; <base64> BEL` when you mouse-select text (and prints "N characters
 *  copied to clipboard"); xterm.js has no built-in OSC 52 handler, so without this the
 *  write is silently dropped and the OS clipboard keeps its previous value. Routes the
 *  decoded text through the caller's existing clipboard writer (the synchronous Electron
 *  clipboard). Write-only — the read/query form is refused (see decodeOsc52). */
export function registerOsc52Clipboard(term: Terminal, write: (text: string) => void): void {
	term.parser.registerOscHandler(52, (data) => {
		const text = decodeOsc52(data);
		if (text) write(text);
		return true; // handled — always claim it so xterm doesn't fall through/print it
	});
}
