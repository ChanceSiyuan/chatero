"use strict";

describe("Zotero.CommandLineIngester", function () {
	describe("#normalizeExternalURI()", function () {
		it("should translate public chatero links to the internal Zotero protocol", function () {
			let input = Services.io.newURI(
				"chatero://open-pdf/library/items/ABCD1234?page=7"
			);
			let output = Zotero.CommandLineIngester.normalizeExternalURI(input);
			assert.equal(
				output.spec,
				"zotero://open-pdf/library/items/ABCD1234?page=7"
			);
		});

		it("should leave file URIs unchanged", function () {
			let input = Services.io.newURI("file:///tmp/paper.pdf");
			assert.strictEqual(Zotero.CommandLineIngester.normalizeExternalURI(input), input);
		});
	});
});
