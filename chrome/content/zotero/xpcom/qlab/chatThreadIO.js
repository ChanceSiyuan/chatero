/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Persist Chat threads under work/qlab-zotero/chat/ (Cursor composer parity).
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const CHAT_DIR = 'work/qlab-zotero/chat';
	const INDEX_FILE = 'threads.json';

	function safeId(id) {
		return String(id || '').replace(/[^\w.-]+/g, '_').slice(0, 120);
	}

	Zotero.QLab.chatThreadDir = function () {
		return CHAT_DIR;
	};

	Zotero.QLab.chatThreadIndexPath = function () {
		return `${CHAT_DIR}/${INDEX_FILE}`;
	};

	Zotero.QLab.chatThreadFilePath = function (threadId) {
		return `${CHAT_DIR}/${safeId(threadId)}.json`;
	};

	Zotero.QLab.loadChatThreadIndex = async function (workspaceRoot, host) {
		if (!workspaceRoot || !host) {
			return [];
		}
		try {
			let text = await Zotero.QLab.readWorkspaceRel(
				workspaceRoot,
				Zotero.QLab.chatThreadIndexPath(),
				host
			);
			let parsed = JSON.parse(text);
			return Array.isArray(parsed) ? parsed : [];
		}
		catch (e) {
			return [];
		}
	};

	Zotero.QLab.loadChatThread = async function (workspaceRoot, threadId, host) {
		if (!workspaceRoot || !threadId || !host) {
			return null;
		}
		try {
			let text = await Zotero.QLab.readWorkspaceRel(
				workspaceRoot,
				Zotero.QLab.chatThreadFilePath(threadId),
				host
			);
			return JSON.parse(text);
		}
		catch (e) {
			return null;
		}
	};

	Zotero.QLab.saveChatThread = async function (workspaceRoot, snapshot, host) {
		if (!workspaceRoot || !snapshot || !snapshot.threadId || !host) {
			return;
		}
		let threadId = snapshot.threadId;
		let path = Zotero.QLab.chatThreadFilePath(threadId);
		let body = JSON.stringify({
			threadId,
			parentThreadId: snapshot.parentThreadId || null,
			title: snapshot.title || 'Chat',
			updatedAt: snapshot.updatedAt || new Date().toISOString(),
			messages: snapshot.messages || [],
			tags: snapshot.tags || [],
		}, null, 2);
		await Zotero.QLab.writeWorkspaceRel(workspaceRoot, path, body, host);
		let index = await Zotero.QLab.loadChatThreadIndex(workspaceRoot, host);
		let entry = {
			threadId,
			title: snapshot.title || 'Chat',
			updatedAt: snapshot.updatedAt || new Date().toISOString(),
			parentThreadId: snapshot.parentThreadId || null,
		};
		index = index.filter(row => row.threadId !== threadId);
		index.unshift(entry);
		if (index.length > 48) {
			index = index.slice(0, 48);
		}
		await Zotero.QLab.writeWorkspaceRel(
			workspaceRoot,
			Zotero.QLab.chatThreadIndexPath(),
			JSON.stringify(index, null, 2),
			host
		);
	};

	Zotero.QLab.snapshotChatHost = function (host) {
		if (!host) {
			return null;
		}
		let messages = (host._qlabMessages || []).map(m => ({
			id: m.id,
			role: m.role,
			text: m.text,
			status: m.status || '',
		}));
		let tags = Zotero.QLab.ChatComposerContext
			? Zotero.QLab.ChatComposerContext.list()
			: [];
		let title = messages.find(m => m.role === 'user' && m.text.trim())
			? messages.find(m => m.role === 'user' && m.text.trim()).text.trim().slice(0, 64)
			: 'Chat';
		return {
			threadId: host._qlabThreadId,
			parentThreadId: host._qlabParentThreadId || null,
			title,
			updatedAt: new Date().toISOString(),
			messages,
			tags: tags.map(t => ({
				id: t.id,
				kind: t.kind,
				label: t.label,
				detail: t.detail,
				text: t.text,
				stableKey: t.stableKey,
				origin: t.origin,
			})),
		};
	};

	Zotero.QLab.hydrateChatHost = function (host, snapshot) {
		if (!host || !snapshot) {
			return;
		}
		host._qlabThreadId = snapshot.threadId;
		host._qlabParentThreadId = snapshot.parentThreadId || null;
		host._qlabMessages = Array.isArray(snapshot.messages)
			? snapshot.messages.map(m => ({ ...m }))
			: [];
		if (Zotero.QLab.ChatComposerContext && Array.isArray(snapshot.tags)) {
			Zotero.QLab.ChatComposerContext.clear();
			for (let tag of snapshot.tags) {
				try {
					Zotero.QLab.ChatComposerContext.add(tag);
				}
				catch (e) {}
			}
		}
	};

	Zotero.QLab.persistChatHost = async function (host, root) {
		if (!host || !root || !host._qlabThreadId) {
			return;
		}
		let hostIO = Zotero.QLab.QmdDraftIO.createGeckoHost();
		let snapshot = Zotero.QLab.snapshotChatHost(host);
		await Zotero.QLab.saveChatThread(root, snapshot, hostIO);
	};

	Zotero.QLab.loadLatestChatThread = async function (host, root) {
		if (!host || !root) {
			return null;
		}
		let hostIO = Zotero.QLab.QmdDraftIO.createGeckoHost();
		let index = await Zotero.QLab.loadChatThreadIndex(root, hostIO);
		if (!index.length) {
			return null;
		}
		let thread = await Zotero.QLab.loadChatThread(root, index[0].threadId, hostIO);
		if (thread) {
			Zotero.QLab.hydrateChatHost(host, thread);
		}
		return thread;
	};

	Zotero.QLab.forkChatThread = function (host) {
		if (!host) {
			return null;
		}
		let parentId = host._qlabThreadId;
		host._qlabParentThreadId = parentId;
		host._qlabThreadId = `thread-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		return host._qlabThreadId;
	};
})();
