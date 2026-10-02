import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { GitHubBroker, normalizeRepository } from '../src/github-api.mjs';

test('repository names are restricted to owner/name', () => {
  assert.equal(normalizeRepository('owner/repo'), 'owner/repo');
  assert.equal(normalizeRepository('owner/repo.name-1'), 'owner/repo.name-1');
  assert.equal(normalizeRepository('owner/repo/extra'), null);
  assert.equal(normalizeRepository('https://github.com/owner/repo'), null);
});

test('GitHub App JWT is signed and installation tokens stay server-side', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const broker = new GitHubBroker({ GITHUB_APP_ID: '123', GITHUB_PRIVATE_KEY_PATH: 'unused.pem' });
  broker.loadPrivateKey = () => privateKey;

  const jwt = broker.appJwt();
  const [header, payload, signature] = jwt.split('.');
  assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')), true);

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/app/installations?')) return Response.json([{ id: 456 }]);
    if (String(url).endsWith('/app/installations/456/access_tokens')) return Response.json({ token: 'server-secret-token', expires_at: new Date(Date.now() + 3600000).toISOString() });
    if (String(url).endsWith('/repos/owner/repo')) return Response.json({ full_name: 'owner/repo', description: 'test', private: true, default_branch: 'main', html_url: 'https://github.com/owner/repo', open_issues_count: 1 });
    if (String(url).includes('/repos/owner/repo/issues?')) return Response.json([{ number: 1, title: 'Issue', body: '', state: 'open', html_url: 'https://github.com/owner/repo/issues/1', user: { login: 'octocat' }, comments: 0, updated_at: new Date().toISOString() }]);
    return Response.json({ message: 'Not found' }, { status: 404 });
  };

  try {
    const result = await broker.overview('owner/repo');
    assert.equal(result.repository.fullName, 'owner/repo');
    assert.equal(result.issues[0].number, 1);
    assert.equal(JSON.stringify(result).includes('server-secret-token'), false);
    assert.equal(calls.some((call) => call.options.headers.authorization === 'Bearer server-secret-token'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
