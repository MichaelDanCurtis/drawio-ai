/**
 * A draw.io file reduced to its content: page view state (the attributes of
 * <mxGraphModel>: scroll position, grid, page view...) and attribute order are
 * dropped, because draw.io rewrites them when a page is merely visited.
 */
export function diagramContent(xml: string): string {
	return xml
		.replace(/<mxGraphModel[^>]*>/g, "<mxGraphModel>")
		.replace(/<([\w:]+)((?:\s+[\w:.-]+="[^"]*")+)\s*(\/?)>/g, (_m, tag: string, attrs: string, close: string) => `<${tag} ${attrs.trim().match(/[\w:.-]+="[^"]*"/g)!.sort().join(" ")}${close}>`)
		.replace(/>\s+</g, "><")
		.trim();
}
