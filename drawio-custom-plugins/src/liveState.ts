/**
 * What the sharing of a diagram (liveshare.ts) tells the other editor tools.
 *
 * `loading`: the shared diagram is being put in place of the open one, with this person's own
 * changes going back on top afterwards. For a moment the diagram is then not what it will be:
 * a change of the AI's that is under review may be gone and come back. The review does not
 * look at the diagram during that time (it would find nothing pending and end itself).
 */
export const liveState = {
	loading: false,
	/** Called when a loading is over. */
	loaded: [] as (() => void)[],
	/**
	 * `locked`: the cells on the page shown that someone else on the shared diagram holds (they
	 * have them selected). The server refuses a change that touches one, whole, so nothing here
	 * should make one: they cannot be selected, and the AI's edits leave them be.
	 */
	locked: new Set<string>(),
};
