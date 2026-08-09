/*
	***** BEGIN LICENSE BLOCK *****

	Copyright © 2026 Chance Siyuan / Chatero contributors

	This file is part of Chatero (a Zotero fork).

	***** END LICENSE BLOCK *****
*/

Zotero.QLab = Zotero.QLab || {};

(function () {
	const SCHEMA_VERSION = 1;
	const SHA256 = /^[a-f0-9]{64}$/;
	const MODES = new Set(['0600', '0644', '0700', '0755']);
	const KINDS = new Set(['file', 'directory']);

	function fail(message) {
		throw new Error(`Invalid QLab starter manifest: ${message}`);
	}

	function utf8Bytes(value) {
		let bytes = [];
		for (let i = 0; i < value.length; i++) {
			let code = value.charCodeAt(i);
			if (code >= 0xD800 && code <= 0xDBFF && i + 1 < value.length) {
				let next = value.charCodeAt(i + 1);
				if (next >= 0xDC00 && next <= 0xDFFF) {
					code = 0x10000 + ((code - 0xD800) << 10) + next - 0xDC00;
					i++;
				}
			}
			if (code < 0x80) bytes.push(code);
			else if (code < 0x800) bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
			else if (code < 0x10000) bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
			else bytes.push(0xF0 | (code >> 18), 0x80 | ((code >> 12) & 0x3F), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
		}
		return bytes;
	}

	function sha256(value) {
		let bytes = utf8Bytes(String(value));
		let bitLength = bytes.length * 8;
		bytes.push(0x80);
		while ((bytes.length % 64) !== 56) bytes.push(0);
		for (let i = 7; i >= 0; i--) bytes.push((bitLength / Math.pow(2, i * 8)) & 0xFF);
		let hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
		let constants = [
			0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
			0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
			0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
			0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
			0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
			0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
			0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
			0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
		];
		for (let offset = 0; offset < bytes.length; offset += 64) {
			let words = new Array(64);
			for (let i = 0; i < 16; i++) words[i] = ((bytes[offset + i * 4] << 24) | (bytes[offset + i * 4 + 1] << 16) | (bytes[offset + i * 4 + 2] << 8) | bytes[offset + i * 4 + 3]) >>> 0;
			for (let i = 16; i < 64; i++) {
				let a = words[i - 15], b = words[i - 2];
				let s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
				let s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
				words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
			}
			let [a, b, c, d, e, f, g, h] = hash;
			for (let i = 0; i < 64; i++) {
				let s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
				let choose = (e & f) ^ (~e & g);
				let temp1 = (h + s1 + choose + constants[i] + words[i]) >>> 0;
				let s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
				let majority = (a & b) ^ (a & c) ^ (b & c);
				h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + s0 + majority) >>> 0;
			}
			hash = [hash[0] + a, hash[1] + b, hash[2] + c, hash[3] + d, hash[4] + e, hash[5] + f, hash[6] + g, hash[7] + h].map(word => word >>> 0);
		}
		return hash.map(word => word.toString(16).padStart(8, '0')).join('');
	}

	function freezeRecord(record) {
		return Object.freeze(record);
	}

	function manifestDigest(entries) {
		return sha256(JSON.stringify({ schemaVersion: SCHEMA_VERSION, entries }));
	}

	function bytewiseCompare(left, right) {
		let leftBytes = utf8Bytes(left);
		let rightBytes = utf8Bytes(right);
		let length = Math.min(leftBytes.length, rightBytes.length);
		for (let index = 0; index < length; index++) {
			if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
		}
		return leftBytes.length - rightBytes.length;
	}

	function statKind(stat) {
		if (stat && typeof stat.isFile === 'function' && stat.isFile()) return 'file';
		if (stat && typeof stat.isDirectory === 'function' && stat.isDirectory()) return 'directory';
		if (stat && (stat.type === 'file' || stat.type === 'regular')) return 'file';
		return stat && stat.type === 'directory' ? 'directory' : '';
	}

	async function pathStatus(path, host) {
		let symlink = false;
		try {
			symlink = Boolean(await host.isSymlink(path));
		}
		catch {}
		if (symlink) {
			return { exists: true, kind: '', symlink: true };
		}
		let exists = false;
		try {
			exists = await host.exists(path);
		}
		catch {}
		if (!exists) {
			return { exists: false, kind: '', symlink: false };
		}
		try {
			return { exists: true, kind: statKind(await host.stat(path)), symlink: false };
		}
		catch {
			return { exists: true, kind: '', symlink: false };
		}
	}

	async function hasSymlinkParent(root, relativePath, host) {
		let parent = root;
		let segments = relativePath.split('/');
		for (let i = 0; i < segments.length - 1; i++) {
			parent = host.join(parent, segments[i]);
			let status = await pathStatus(parent, host);
			if (status.exists && status.symlink) return true;
		}
		return false;
	}

	function planRecord(entry, extra = {}) {
		return freezeRecord({ path: entry.path, kind: entry.kind, mode: entry.mode, ...(entry.digest ? { digest: entry.digest } : {}), ...extra });
	}

	Zotero.QLab.validateQLabStarterManifest = function (raw) {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('expected an object');
		if (raw.schemaVersion !== SCHEMA_VERSION) fail('unsupported schema version');
		if (typeof raw.digest !== 'string' || !SHA256.test(raw.digest)) fail('digest must be a lowercase SHA-256');
		if (!Array.isArray(raw.entries)) fail('entries must be an array');
		let paths = new Set();
		let pathKinds = new Map();
		let entries = raw.entries.map((rawEntry, index) => {
			if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) fail(`entry ${index} must be an object`);
			let path = String(rawEntry.path || '');
			if (!Zotero.QLab.isSafeWorkspaceRelativePath(path)) fail(`entry ${index} has an unsafe path`);
			let folded = path.toLowerCase();
			if (paths.has(folded)) fail(`duplicate path ${path}`);
			paths.add(folded);
			if (!KINDS.has(rawEntry.kind)) fail(`entry ${index} has an invalid kind`);
			if (typeof rawEntry.mode !== 'string' || !MODES.has(rawEntry.mode)) fail(`entry ${index} has an invalid mode`);
			if (rawEntry.kind === 'file' && (typeof rawEntry.digest !== 'string' || !SHA256.test(rawEntry.digest))) fail(`entry ${index} file digest must be a lowercase SHA-256`);
			if (rawEntry.kind === 'directory' && rawEntry.digest !== undefined) fail(`entry ${index} directory must not have a digest`);
			pathKinds.set(folded, rawEntry.kind);
			let record = { path, kind: rawEntry.kind, mode: rawEntry.mode };
			if (rawEntry.kind === 'file') record.digest = rawEntry.digest;
			return record;
		});
		for (let entry of entries) {
			let ancestors = entry.path.split('/');
			ancestors.pop();
			while (ancestors.length) {
				if (pathKinds.get(ancestors.join('/').toLowerCase()) === 'file') fail(`file target is a parent of ${entry.path}`);
				ancestors.pop();
			}
		}
		entries.sort((a, b) => bytewiseCompare(a.path, b.path));
		if (raw.digest !== manifestDigest(entries)) fail('manifest digest mismatch');
		return freezeRecord({ schemaVersion: SCHEMA_VERSION, digest: raw.digest, entries: Object.freeze(entries.map(freezeRecord)) });
	};

	Zotero.QLab.planQLabStarterInstall = async function ({ root, inspection, manifest, host }) {
		if (!inspection || typeof inspection !== 'object' || !host) throw new Error('QLab starter planning requires an inspection and path host');
		let canonicalRoot = await Zotero.QLab.normalizeQLabRoot(root, host);
		if (!canonicalRoot || canonicalRoot !== inspection.root || !inspection.fingerprint) throw new Error('QLab starter inspection is stale');
		let validated = Zotero.QLab.validateQLabStarterManifest(manifest);
		let create = [];
		let preserve = [];
		let conflicts = [];
		for (let path of inspection.conflicts || []) conflicts.push(freezeRecord({ path, reason: 'repository-conflict' }));
		if (inspection.state !== 'incompatible') {
			for (let entry of validated.entries) {
				let target = host.join(canonicalRoot, entry.path);
				if (await hasSymlinkParent(canonicalRoot, entry.path, host)) {
					conflicts.push(planRecord(entry, { reason: 'symlink-parent' }));
					continue;
				}
				let status = await pathStatus(target, host);
				if (!status.exists) create.push(planRecord(entry));
				else if (status.symlink) conflicts.push(planRecord(entry, { reason: 'symlink-target' }));
				else if (status.kind !== entry.kind) conflicts.push(planRecord(entry, { reason: 'existing-kind' }));
				else preserve.push(planRecord(entry));
			}
		}
		let byPath = (a, b) => a.path.localeCompare(b.path);
		create.sort(byPath); preserve.sort(byPath); conflicts.sort(byPath);
		return freezeRecord({
			root: canonicalRoot,
			inspectionFingerprint: inspection.fingerprint,
			manifestDigest: validated.digest,
			digest: sha256(`${inspection.fingerprint}\n${validated.digest}`),
			create: Object.freeze(create),
			preserve: Object.freeze(preserve),
			conflicts: Object.freeze(conflicts),
		});
	};

	Zotero.QLab.isQLabStarterPlanCurrent = async function (plan, inspection) {
		return Boolean(plan && inspection
			&& typeof plan.inspectionFingerprint === 'string'
			&& plan.inspectionFingerprint === inspection.fingerprint
			&& plan.root === inspection.root);
	};
})();
