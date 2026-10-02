import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const apiBase = 'https://api.github.com';

export class GitHubApiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function jsonPart(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function normalizeRepository(value) {
  const repository = String(value || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return null;
  return repository;
}

export class GitHubBroker {
  constructor(env = process.env) {
    this.appId = String(env.GITHUB_APP_ID || '').trim();
    this.installationId = String(env.GITHUB_INSTALLATION_ID || '').trim();
    this.privateKeyPath = String(env.GITHUB_PRIVATE_KEY_PATH || '').trim();
    this.apiVersion = String(env.GITHUB_API_VERSION || '2026-03-10');
    this.privateKey = null;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  get configured() {
    return Boolean(this.appId && this.privateKeyPath);
  }

  loadPrivateKey() {
    if (!this.configured) throw new GitHubApiError('GitHub App is not configured on this server', 503);
    if (!this.privateKey) this.privateKey = readFileSync(this.privateKeyPath, 'utf8');
    return this.privateKey;
  }

  appJwt() {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${jsonPart({ alg: 'RS256', typ: 'JWT' })}.${jsonPart({ iat: now - 60, exp: now + 540, iss: this.appId })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).end().sign(this.loadPrivateKey()).toString('base64url');
    return `${unsigned}.${signature}`;
  }

  async rawRequest(path, { method = 'GET', body, authorization } = {}) {
    let response;
    try {
      response = await fetch(`${apiBase}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization,
          'content-type': 'application/json',
          'user-agent': 'session-share-server',
          'x-github-api-version': this.apiVersion
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000)
      });
    } catch {
      throw new GitHubApiError('Could not reach the GitHub API', 502);
    }
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw new GitHubApiError(payload?.message || `GitHub API request failed (${response.status})`, response.status);
    return payload;
  }

  async resolveInstallationId() {
    if (this.installationId) return this.installationId;
    const installations = await this.rawRequest('/app/installations?per_page=2', { authorization: `Bearer ${this.appJwt()}` });
    if (installations.length !== 1) {
      throw new GitHubApiError('Set GITHUB_INSTALLATION_ID when the GitHub App has zero or multiple installations', 503);
    }
    this.installationId = String(installations[0].id);
    return this.installationId;
  }

  async installationToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60000) return this.token;
    const installationId = await this.resolveInstallationId();
    const result = await this.rawRequest(`/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
      method: 'POST',
      authorization: `Bearer ${this.appJwt()}`
    });
    this.token = result.token;
    this.tokenExpiresAt = Date.parse(result.expires_at);
    return this.token;
  }

  async request(path, options = {}) {
    const token = await this.installationToken();
    return this.rawRequest(path, { ...options, authorization: `Bearer ${token}` });
  }

  repositoryPath(repository) {
    const normalized = normalizeRepository(repository);
    if (!normalized) throw new GitHubApiError('Invalid GitHub repository name', 400);
    return normalized.split('/').map(encodeURIComponent).join('/');
  }

  async overview(repository) {
    const path = this.repositoryPath(repository);
    const [repo, issues] = await Promise.all([
      this.request(`/repos/${path}`),
      this.request(`/repos/${path}/issues?state=open&per_page=30&sort=updated&direction=desc`)
    ]);
    return {
      repository: {
        fullName: repo.full_name,
        description: repo.description || '',
        private: Boolean(repo.private),
        defaultBranch: repo.default_branch,
        htmlUrl: repo.html_url,
        openIssues: repo.open_issues_count
      },
      issues: issues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body || '',
        state: issue.state,
        htmlUrl: issue.html_url,
        author: issue.user?.login || 'unknown',
        comments: issue.comments || 0,
        pullRequest: Boolean(issue.pull_request),
        updatedAt: issue.updated_at
      }))
    };
  }

  async createIssue(repository, title, body) {
    const path = this.repositoryPath(repository);
    return this.request(`/repos/${path}/issues`, { method: 'POST', body: { title, body } });
  }

  async createComment(repository, issueNumber, body) {
    const path = this.repositoryPath(repository);
    return this.request(`/repos/${path}/issues/${issueNumber}/comments`, { method: 'POST', body: { body } });
  }
}
