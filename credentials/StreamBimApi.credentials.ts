import type {
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IDataObject,
	IHttpRequestHelper,
	INodeProperties,
} from 'n8n-workflow';

/**
 * Same pattern as n8n-nodes-base (e.g. BaserowApi, FormIoApi):
 * - Hidden `sessionToken` with `typeOptions.expirable` so n8n runs `preAuthentication` when it is empty, on credential test, or when expired.
 * - `preAuthentication` performs StreamBIM login for username/password only; bearer uses `idToken` in expressions (no cached session).
 * - `authenticate.type: "generic"` adds JSON:API headers + `Authorization` from credentials (n8n merges this into the credential test request).
 * - `test.request` is only URL/method/query — auth comes from `authenticate`, not duplicated in `test`.
 */
export class StreamBimApi implements ICredentialType {
	name = 'streamBimApi';

	displayName = 'StreamBIM API';

	documentationUrl = 'https://streambim.com';

	properties: INodeProperties[] = [
		{
			displayName: 'Region',
			name: 'environment',
			type: 'string',
			default: 'app',
			placeholder: 'app',
			description:
				'Regional subdomain for all StreamBIM API calls: https://{subdomain}.streambim.com. Must match your tenant (see https://global.streambim.com/regions.json), e.g. app, sweden.',
		},
		{
			displayName: 'Authentication',
			name: 'authentication',
			type: 'options',
			options: [
				{
					name: 'Bearer Token',
					value: 'bearer',
					description: 'Use an ID token from login (recommended for MFA accounts)',
				},
				{
					name: 'Username and Password',
					value: 'usernamePassword',
					description: 'Log in with POST /auth/v1/login each time the node runs (MFA not supported)',
				},
			],
			default: 'bearer',
		},
		{
			displayName: 'ID Token',
			name: 'idToken',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			displayOptions: {
				show: {
					authentication: ['bearer'],
				},
			},
			description: 'Bearer token (idToken) from POST /auth/v1/login',
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			default: '',
			displayOptions: {
				show: {
					authentication: ['usernamePassword'],
				},
			},
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			displayOptions: {
				show: {
					authentication: ['usernamePassword'],
				},
			},
		},
		{
			displayName: 'Session Token',
			name: 'sessionToken',
			type: 'hidden',
			typeOptions: {
				expirable: true,
				password: true,
			},
			default: '',
		},
	];

	async preAuthentication(
		this: IHttpRequestHelper,
		credentials: ICredentialDataDecryptedObject,
	): Promise<IDataObject> {
		if (credentials.authentication !== 'usernamePassword') {
			// Bearer: `authenticate` uses `idToken` directly. Return nothing so n8n does not require `sessionToken`.
			return {};
		}

		const env = ((credentials.environment as string) || 'app').trim() || 'app';
		const baseUrl = `https://${env}.streambim.com`;
		const username = (credentials.username as string)?.trim();
		const password = credentials.password as string;
		if (!username || !password) {
			throw new Error('Username and password are required for this authentication mode');
		}

		const response = (await this.helpers.httpRequest({
			method: 'POST',
			url: `${baseUrl}/auth/v1/login`,
			headers: {
				'Content-Type': 'application/json; charset=utf-8',
			},
			body: {
				username,
				password,
			},
			json: true,
			ignoreHttpStatusErrors: true,
		})) as IDataObject;

		if (response.error) {
			throw new Error(
				`StreamBIM login failed (${env}): ${String(response.error)}. Check Region matches your organization.`,
			);
		}
		if (response.result === 'CHALLENGE_REQUESTED') {
			throw new Error(
				'MFA is required. Use Bearer token authentication with an idToken from a completed login.',
			);
		}
		const idToken = response.idToken as string | undefined;
		if (!idToken) {
			throw new Error('Login did not return an idToken');
		}
		return { sessionToken: idToken };
	}

	authenticate = {
		type: 'generic' as const,
		properties: {
			headers: {
				Authorization:
					'={{ "Bearer " + ($credentials.authentication === "usernamePassword" ? $credentials.sessionToken : $credentials.idToken) }}',
				Accept: 'application/vnd.api+json',
				'Content-Type': 'application/vnd.api+json',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{ "https://" + ($credentials.environment || "app") + ".streambim.com" }}',
			url: '/mgw/api/v3/projects',
			method: 'GET',
			qs: {
				'page[limit]': 1,
			},
		},
	};
}
