/**
 * Document download links.
 *
 * `GET /project-{projectId}/api/v1/documents/{documentId}/downloadlink` returns a
 * path relative to the project's API root, e.g.
 * `/documents/1002/_download/model.ifc?microtoken=...` (the API docs show it
 * without the leading slash). The file is served at
 * `{environment}/project-{projectId}/api/v1{path}`. The same path on the bare
 * environment host returns the web app's HTML page instead of the file.
 */

/** Strip whitespace and surrounding JSON quotes from a download link response body. */
export function cleanDownloadLink(raw: unknown): string {
	return String(raw ?? '')
		.trim()
		.replace(/^"+|"+$/g, '');
}

/** Turn a cleaned download link into an absolute URL. */
export function resolveDownloadUrl(baseUrl: string, projectId: string, link: string): string {
	if (/^https?:\/\//i.test(link)) return link;
	// Already rooted at a project; don't add a second prefix.
	if (/^\/project-[^/]+\//.test(link)) return `${baseUrl}${link}`;
	const apiRoot = `${baseUrl}/project-${projectId}/api/v1`;
	return link.startsWith('/') ? `${apiRoot}${link}` : `${apiRoot}/${link}`;
}
