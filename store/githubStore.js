/* Minimal GitHub content store using REST API (no octokit dep) */
const crypto = require('crypto');

class GitHubStore {
  constructor({ token, repo, branch='main', file='store/db.json' }) {
    this.token = token;
    const [owner, name] = (repo||'/:/').split('/');
    this.owner = owner; this.name = name;
    this.branch = branch;
    this.file = file;
    this.lastSha = null;
    this.cache = null;
    this.cacheTs = 0;
  }

  api(path, init={}) {
    if (!this.token) throw new Error('GITHUB_TOKEN missing');
    init.headers = Object.assign({
      'Authorization': `token ${this.token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'bunca-haccp'
    }, init.headers||{});
    return fetch(`https://api.github.com${path}`, init);
  }

  async read() {
    const fresh = (Date.now() - this.cacheTs) < 5000; // 5s cache
    if (fresh && this.cache) return this.cache;

    // try fetch
    const r = await this.api(`/repos/${this.owner}/${this.name}/contents/${encodeURIComponent(this.file)}?ref=${this.branch}`);
    if (r.status === 200) {
      const j = await r.json();
      const buf = Buffer.from(j.content, 'base64').toString('utf8');
      this.lastSha = j.sha;
      this.cache = buf ? JSON.parse(buf) : {};
      this.cacheTs = Date.now();
      return this.cache;
    }
    // create default file if not exists
    const initDb = { users: [], shops: [], entries: {} };
    await this.write(initDb, 'Initialize db.json');
    return initDb;
  }

  async write(data, message='Update db.json') {
    const body = {
      message,
      branch: this.branch,
      content: Buffer.from(JSON.stringify(data, null, 2), 'utf8').toString('base64'),
      sha: this.lastSha || undefined
    };
    const r = await this.api(`/repos/${this.owner}/${this.name}/contents/${encodeURIComponent(this.file)}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`GitHub write failed: ${r.status} ${text}`);
    }
    const j = await r.json();
    this.lastSha = j.content?.sha || null;
    this.cache = data;
    this.cacheTs = Date.now();
    return data;
  }
}

module.exports = { GitHubStore };
