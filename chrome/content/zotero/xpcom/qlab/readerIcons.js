/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Reader toolbar icons as data URLs. Reader documents cannot load chrome://
 * resources, so icons must be inlined (same constraint as the XPI).
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	function svgDataUrl(svg) {
		return 'data:image/svg+xml,' + encodeURIComponent(String(svg).trim());
	}

	Zotero.QLab.ReaderIcons = {
		chat: svgDataUrl(`
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
				<defs>
					<linearGradient id="g" x1="8" y1="6" x2="56" y2="58" gradientUnits="userSpaceOnUse">
						<stop stop-color="#9b8cff"/><stop offset="1" stop-color="#5b4bd8"/>
					</linearGradient>
				</defs>
				<rect x="4" y="4" width="56" height="56" rx="16" fill="url(#g)"/>
				<path d="M18 20.5h28a3.5 3.5 0 0 1 3.5 3.5v16a3.5 3.5 0 0 1-3.5 3.5H31l-8.5 6v-6H18a3.5 3.5 0 0 1-3.5-3.5V24a3.5 3.5 0 0 1 3.5-3.5Z"
					fill="none" stroke="white" stroke-width="4" stroke-linejoin="round"/>
				<path d="m24 28 5 4-5 4m9 0h8" fill="none" stroke="white" stroke-width="3.5"
					stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
		`),
		chatLayout: svgDataUrl(`
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
				stroke="#5a5a5f" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
				<path d="M20.5 15.5a3 3 0 0 1-3 3H9l-5.5 3v-15a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3Z"/>
				<path d="M8 9h8M8 13h5"/>
			</svg>
		`),
		editorSplit: svgDataUrl(`
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22">
				<rect x="2" y="3.5" width="18" height="15" rx="3" fill="none" stroke="#5a5a5f" stroke-width="1.6"/>
				<line x1="11" y1="3.5" x2="11" y2="18.5" stroke="#5a5a5f" stroke-width="1.6"/>
				<path d="M4.6 8h3.8M4.6 11h3.8M4.6 14h2.6" stroke="#5a5a5f" stroke-width="1.3" stroke-linecap="round"/>
				<path d="M13.6 8.2l4.6 0M13.6 11l4.6 0M13.6 13.8l3 0" stroke="#0a84ff" stroke-width="1.3" stroke-linecap="round"/>
			</svg>
		`),
		desk: svgDataUrl(`
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22">
				<rect x="2" y="3.5" width="18" height="15" rx="3" fill="none" stroke="#5a5a5f" stroke-width="1.6"/>
				<line x1="7.3" y1="3.5" x2="7.3" y2="18.5" stroke="#5a5a5f" stroke-width="1.6"/>
				<line x1="14.7" y1="3.5" x2="14.7" y2="18.5" stroke="#5a5a5f" stroke-width="1.6"/>
				<path d="M3.8 8h2.2M3.8 11h2.2M10.5 8h2.2M10.5 11h2.2M17.2 8h2.2M17.2 11h2.2"
					stroke="#5a5a5f" stroke-width="1.2" stroke-linecap="round"/>
			</svg>
		`),
		quote: svgDataUrl(`
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22" fill="none"
				stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
				<line x1="5" y1="4" x2="5" y2="18"/>
				<line x1="9" y1="6" x2="18" y2="6"/>
				<line x1="9" y1="11" x2="16" y2="11"/>
				<line x1="9" y1="16" x2="18" y2="16"/>
			</svg>
		`),
	};
})();
