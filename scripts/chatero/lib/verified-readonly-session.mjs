let sequence = 0;

export async function createVerifiedReadonlyRead(QLab, {
	relativePath,
	descriptor = null,
	text = "",
	root = "/verified-readonly-test",
} = {}) {
	const normalized = QLab.createWorkspaceDocumentDescriptor({
		relativePath: relativePath || descriptor?.relativePath,
	});
	const classification = QLab.classifyWorkspaceDocument(normalized.relativePath);
	const access = Object.freeze({ sequence: ++sequence });
	const active = new WeakSet([access]);
	const capability = Object.freeze({
		root,
		relativePath: normalized.relativePath,
		canonicalPath: `${root}/${normalized.relativePath}`,
		authority: classification.authority,
		kind: classification.kind,
		writable: false,
		access,
	});
	const io = QLab.createReadonlyDocumentIO({
		root,
		host: {
			verifyAccess: candidate => active.has(candidate),
			realPath: async value => value,
			readVerified: async () => ({
				text: String(text),
				size: String(text).length,
				lastModified: sequence,
			}),
		},
	});
	return io.read(capability, descriptor || normalized);
}

export async function createVerifiedReadonlySession(QLab, options = {}) {
	const verifiedRead = await createVerifiedReadonlyRead(QLab, options);
	return QLab.createQmdDocumentSession({
		verifiedRead,
		onState: options.onState,
	});
}
