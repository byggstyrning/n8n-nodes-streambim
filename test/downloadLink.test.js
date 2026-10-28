// Unit tests for document download link resolution. Run with `pnpm test`.
// All fixtures are synthetic.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cleanDownloadLink, resolveDownloadUrl } = require('../dist/nodes/shared/streamBimDownloadLink');

const BASE = 'https://app.streambim.com';
const PROJECT = '42';

test('a leading-slash path resolves under the project API root', () => {
	assert.equal(
		resolveDownloadUrl(BASE, PROJECT, '/documents/1002/_download/model.ifc?microtoken=abc'),
		'https://app.streambim.com/project-42/api/v1/documents/1002/_download/model.ifc?microtoken=abc',
	);
});

test('a path without a leading slash resolves under the project API root', () => {
	assert.equal(
		resolveDownloadUrl(BASE, PROJECT, 'documents/1002/download/filename.pdf'),
		'https://app.streambim.com/project-42/api/v1/documents/1002/download/filename.pdf',
	);
});

test('a path already rooted at a project is not prefixed twice', () => {
	assert.equal(
		resolveDownloadUrl(BASE, PROJECT, '/project-42/api/v1/documents/1002/_download/a.pdf'),
		'https://app.streambim.com/project-42/api/v1/documents/1002/_download/a.pdf',
	);
});

test('a full URL is returned unchanged', () => {
	const url = 'https://files.example.com/a.pdf?sig=1';
	assert.equal(resolveDownloadUrl(BASE, PROJECT, url), url);
});

test('cleanDownloadLink strips whitespace and JSON quotes', () => {
	assert.equal(cleanDownloadLink(' "/documents/1/_download/a.ifc"\n'), '/documents/1/_download/a.ifc');
	assert.equal(cleanDownloadLink(undefined), '');
});
