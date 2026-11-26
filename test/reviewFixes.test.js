// Unit tests for token refresh after a 401 and Project ID parsing. Run with `pnpm test`.
// All fixtures are synthetic.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { streamBimJsonApiRequest } = require('../dist/nodes/shared/GenericFunctions');
const { getProjectIdNumber } = require('../dist/nodes/StreamBim/resources/_runHelpers');

/** Fake context: logins hand out t1, t2, ...; API calls with an expired token answer 401. */
function fakeContext(authentication, expired) {
	const seen = { logins: 0, apiTokens: [] };
	return {
		seen,
		getNode: () => ({ name: 'StreamBIM' }),
		getCredentials: async () => ({
			authentication,
			username: 'u',
			password: 'p',
			idToken: 'static',
			environment: 'app',
		}),
		helpers: {
			request: async (options) => {
				const url = options.url ?? options.uri;
				if (url.endsWith('/auth/v1/login')) {
					seen.logins += 1;
					return { idToken: `t${seen.logins}` };
				}
				const token = options.headers.Authorization.replace('Bearer ', '');
				seen.apiTokens.push(token);
				if (expired.has(token)) {
					const err = new Error('401 - Unauthorized');
					err.statusCode = 401;
					throw err;
				}
				return { data: { id: '1' } };
			},
		},
	};
}

test('username/password: an expired token triggers one re-login and a retry', async () => {
	const ctx = fakeContext('usernamePassword', new Set(['t1']));
	const cache = {};
	const res = await streamBimJsonApiRequest.call(ctx, 'GET', '/x', cache, undefined, {});
	assert.deepEqual(res, { data: { id: '1' } });
	assert.equal(ctx.seen.logins, 2);
	assert.deepEqual(ctx.seen.apiTokens, ['t1', 't2']);
	assert.equal(cache.token, 't2');
});

test('username/password: a second 401 after re-login is reported, not retried again', async () => {
	const ctx = fakeContext('usernamePassword', new Set(['t1', 't2']));
	await assert.rejects(streamBimJsonApiRequest.call(ctx, 'GET', '/x', {}, undefined, {}));
	assert.equal(ctx.seen.logins, 2);
	assert.equal(ctx.seen.apiTokens.length, 2);
});

test('bearer: a 401 is reported without a login attempt', async () => {
	const ctx = fakeContext('bearer', new Set(['static']));
	await assert.rejects(streamBimJsonApiRequest.call(ctx, 'GET', '/x', {}, undefined, {}));
	assert.equal(ctx.seen.logins, 0);
	assert.equal(ctx.seen.apiTokens.length, 1);
});

function projectCtx(value) {
	return { getNode: () => ({ name: 'StreamBIM' }), getNodeParameter: () => value };
}

test('getProjectIdNumber accepts a positive whole number', () => {
	assert.equal(getProjectIdNumber(projectCtx('1234'), 0), 1234);
	assert.equal(getProjectIdNumber(projectCtx(' 42 '), 0), 42);
	assert.equal(getProjectIdNumber(projectCtx(7), 0), 7);
});

test('getProjectIdNumber rejects empty, zero and non-numeric values', () => {
	for (const bad of ['', '   ', undefined, null, '0', '-3', '1.5', 'abc']) {
		assert.throws(() => getProjectIdNumber(projectCtx(bad), 0), undefined, String(bad));
	}
});
