/**
 * A small reader of XML text for the Workshop's cleaners. It goes through the text tag by
 * tag, and through a start tag attribute by attribute, so that nothing inside a comment, a
 * piece of text or another attribute's value is taken for a tag or an attribute (a regular
 * expression over the whole text would be). It does not check that the XML is well-formed:
 * what a browser's XML parser would refuse, a diagram never shows.
 */

/**
 * `xml` with every tag passed through `on.tag` and every piece of text between tags through
 * `on.text`. Comments, CDATA sections, processing instructions and declarations pass as they
 * are. Returns undefined when a tag or one of those never ends.
 */
export function mapXml(xml: string, on: { tag?: (tag: string) => string; text?: (text: string) => string }): string | undefined {
	let out = "";
	let at = 0;
	while (at < xml.length) {
		const lt = xml.indexOf("<", at);
		const text = xml.slice(at, lt < 0 ? xml.length : lt);
		out += on.text ? on.text(text) : text;
		if (lt < 0) break;
		const closer = xml.startsWith("<!--", lt) ? "-->" : xml.startsWith("<![CDATA[", lt) ? "]]>" : xml.startsWith("<?", lt) ? "?>" : undefined;
		if (closer) {
			const close = xml.indexOf(closer, lt + 2);
			if (close < 0) return undefined;
			out += xml.slice(lt, close + closer.length);
			at = close + closer.length;
			continue;
		}
		// a tag ends at its ">" outside quotes
		let end = lt + 1;
		let quote = "";
		for (; end < xml.length; end++) {
			const ch = xml[end];
			if (quote) {
				if (ch === quote) quote = "";
			} else if (ch === '"' || ch === "'") quote = ch;
			else if (ch === ">") break;
		}
		if (end >= xml.length) return undefined;
		const tag = xml.slice(lt, end + 1);
		out += on.tag && tag[1] !== "!" ? on.tag(tag) : tag;
		at = end + 1;
	}
	return out;
}

/** What a tag is: its name as written (with any prefix), whether it closes an element, and whether it is empty (<a/>). */
export function tagInfo(tag: string): { name: string; local: string; closing: boolean; empty: boolean } {
	const m = /^<(\/?)([^\s/>]*)/.exec(tag);
	const name = m?.[2] ?? "";
	return { name, local: name.slice(name.indexOf(":") + 1), closing: !!m?.[1], empty: tag.length > 2 && tag[tag.length - 2] === "/" };
}

/**
 * A start tag with each attribute's value (as written, entities and all) passed through
 * `fn`: what it returns replaces the value, undefined leaves it. The new value must not hold
 * the attribute's quote character as it is (see escapeXml).
 */
export function mapAttributes(tag: string, fn: (name: string, raw: string) => string | undefined): string {
	// (one space before the name is enough to find an attribute: "\s+" would try every start in a long run of spaces again and again)
	return tag.replace(/(\s)([^\s=<>"'/]+)(\s*=\s*)("([^"]*)"|'([^']*)')/g, (all, space: string, name: string, eq: string, _quoted, a?: string, b?: string) => {
		const next = fn(name, a ?? b ?? "");
		if (next === undefined) return all;
		const quote = a !== undefined ? '"' : "'";
		return `${space}${name}${eq}${quote}${next}${quote}`;
	});
}

/** A character by its number, or a space when there is no such character. */
export function codePoint(n: number): string {
	return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
}

/** An attribute's value as the parser reads it: the character references and the five named entities decoded. */
export function unescapeXml(v: string): string {
	return v
		.replace(/&#x([0-9a-f]+);/gi, (_m, h) => codePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_m, d) => codePoint(Number(d)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

/** Text as an attribute's value, for either kind of quote; line breaks and tabs survive as references. */
export function escapeXml(v: string): string {
	return v
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;")
		.replace(/\n/g, "&#10;")
		.replace(/\r/g, "&#13;")
		.replace(/\t/g, "&#9;");
}
