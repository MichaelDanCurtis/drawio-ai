declare module "js-yaml" {
	/** Safe schema only: never use loadAll, which executes !!js/function tags. */
	export function safeLoadAll(text: string): any[];
}
