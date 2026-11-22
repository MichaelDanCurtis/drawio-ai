/**
 * Strips credentials from a Mapper input before it is written anywhere (map records in
 * `.drawai/maps/`, shared through git, and the remembered inputs in the app's data folder):
 * - user info in URLs, e.g. `https://user:password@host` or `https://TOKEN@host` → `https://host`
 * - secret-looking query parameters, e.g. `?token=…`, `&sig=…` (Azure SAS), `api_key=…`
 * - `Password=…;` / `Pwd=…;` pairs in connection strings
 * Fields marked secret (or of type password) are dropped by the callers already.
 */
const SECRET_PARAM = /^(password|passwd|pwd|pass|token|access_token|id_token|refresh_token|secret|client_secret|api[-_]?key|apikey|key|sig|signature|auth|authorization|credential|credentials|sas|x-amz-signature|x-amz-security-token)$/i;

export function redactCredentials(value: string): string {
	if (!value) return value;
	let v = value.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s?#@]+@/gi, "$1");
	v = v.replace(/([?&;])([^=&;#\s]+)=([^&;#\s]*)/g, (m, sep, k) => (SECRET_PARAM.test(k) ? `${sep}${k}=REDACTED` : m));
	v = v.replace(/(^|[;\s])((?:password|pwd)\s*=\s*)("[^"]*"|'[^']*'|[^;]*)/gi, "$1$2REDACTED");
	return v;
}

/** The inputs worth keeping: no secret fields, and no credentials inside the rest. */
export function safeInputs(input: Record<string, string>, secretFields: Set<string>): Record<string, string> {
	return Object.fromEntries(Object.entries(input).filter(([k]) => !secretFields.has(k)).map(([k, v]) => [k, typeof v === "string" ? redactCredentials(v) : v]));
}
