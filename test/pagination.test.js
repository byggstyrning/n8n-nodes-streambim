// Unit tests for fetch-all pagination. Run with `pnpm test`.
// All fixtures are synthetic.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
	isLastStreamBimPage,
	streamBimJsonApiGetMany,
	streamBimPlainJsonGetMany,
} = require('../dist/nodes/shared/GenericFunctions');

/** Fake n8n context serving `total` rows, never more than `cap` per page. */
function fakeContext(total, cap) {
	const calls = [];
	return {
		calls,
		getNode: () => ({ name: 'StreamBIM' }),
		getCredentials: async () => ({ authentication: 'bearer', idToken: 't', environment: 'app' }),
		helpers: {
			request: async (options) => {
				const limit = Number(options.qs['page[limit]']);
				const skip = Number(options.qs['page[skip]']);
				calls.push({ limit, skip });
				const n = Math.max(0, Math.min(limit, cap, total - skip));
				return { data: Array.from({ length: n }, (_, k) => ({ id: String(skip + k), type: 'x' })) };
			},
		},
	};
}

const ALL = { mode: 'all', pageLimit: 500, pageSkip: 0, maxPages: 100 };

test('a server cap below the requested page size still returns every row', async () => {
	const ctx = fakeContext(250, 100);
	const res = await streamBimJsonApiGetMany.call(ctx, '/x', {}, {}, ALL);
	assert.equal(res.data.length, 250);
	assert.deepEqual(
		res.data.map((r) => Number(r.id)),
		Array.from({ length: 250 }, (_, k) => k),
	);
	assert.deepEqual(ctx.calls.map((c) => c.skip), [0, 100, 200]);
});

test('the plain-JSON loop handles a server cap the same way', async () => {
	const ctx = fakeContext(250, 100);
	const res = await streamBimPlainJsonGetMany.call(ctx, '/x', {}, {}, ALL);
	assert.equal(res.data.length, 250);
});

test('a list smaller than one page costs one extra empty request', async () => {
	const ctx = fakeContext(37, 1000);
	const res = await streamBimJsonApiGetMany.call(ctx, '/x', {}, {}, ALL);
	assert.equal(res.data.length, 37);
	assert.equal(ctx.calls.length, 2);
});

test('full pages continue until a short or empty page', async () => {
	const ctx = fakeContext(1000, 1000);
	const res = await streamBimJsonApiGetMany.call(ctx, '/x', {}, {}, ALL);
	assert.equal(res.data.length, 1000);
	assert.deepEqual(ctx.calls.map((c) => c.skip), [0, 500, 1000]);
});

test('isLastStreamBimPage', () => {
	assert.equal(isLastStreamBimPage(0, 0, 500), true);
	assert.equal(isLastStreamBimPage(100, 0, 500), false);
	assert.equal(isLastStreamBimPage(100, 100, 500), false);
	assert.equal(isLastStreamBimPage(37, 100, 500), true);
	assert.equal(isLastStreamBimPage(600, 0, 500), true);
});
