'use strict';
/** 账号系统：注册 / 登录 / 游客，scrypt 加盐哈希 + 持久化 token 会话 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const NAME_RE = /^[\w\u4e00-\u9fa5·-]{1,16}$/u;
const COLORS = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990', '#dcbeff',
  '#9a6324', '#800000', '#aaffc3', '#808000', '#000075', '#a9a9a9',
];

class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class Auth {
  constructor(file, options = {}) {
    this.file = file;
    this.sessionMs = (options.sessionDays || 30) * 24 * 3600 * 1000;
    /**
     * **游客登录开关**（config.json 的 `allowGuests`，见 server/index.js 的 resolveAllowGuests）。
     * 默认 **false**：本服务器要求注册账号或登录已有账号，`guest()` 一律拒绝
     * （抛 FORBIDDEN，HTTP 层据此回 403）。测试可以 `--allow-guests` / `DSH_ALLOW_GUESTS=1`
     * 把临时实例打开 —— 这样"生产上关掉游客"与"测试里批量造临时玩家"两件事互不牵制。
     */
    this.allowGuests = options.allowGuests === true;
    this.users = new Map();      // id -> user
    this.byName = new Map();     // lowercase name -> id
    this.tokens = new Map();     // token -> { userId, exp }
    this.loginFailures = new Map(); // ip -> { count, until }
    this._saveTimer = null;
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const u of raw.users || []) {
        this.users.set(u.id, u);
        this.byName.set(u.name.toLowerCase(), u.id);
      }
      const now = Date.now();
      for (const [t, v] of Object.entries(raw.tokens || {})) {
        if (v && v.exp > now) this.tokens.set(t, v);
      }
    } catch (err) {
      console.error('[auth] 读取账号文件失败，将以空账号库启动:', err.message);
    }
  }

  scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.save();
    }, 500);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  save() {
    const data = {
      version: 1,
      users: [...this.users.values()],
      tokens: Object.fromEntries(this.tokens),
    };
    const tmp = this.file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[auth] 保存失败:', err.message);
    }
  }

  _hash(password, salt) {
    return crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  }

  _pickColor() {
    const used = new Map();
    for (const u of this.users.values()) used.set(u.color, (used.get(u.color) || 0) + 1);
    let best = COLORS[0];
    let bestCount = Infinity;
    for (const c of COLORS) {
      const n = used.get(c) || 0;
      if (n < bestCount) { bestCount = n; best = c; }
    }
    return best;
  }

  _newToken(userId) {
    const token = crypto.randomBytes(24).toString('hex');
    this.tokens.set(token, { userId, exp: Date.now() + this.sessionMs });
    return token;
  }

  _pruneTokens() {
    const now = Date.now();
    for (const [t, v] of this.tokens) if (!v || v.exp <= now) this.tokens.delete(t);
  }

  register(name, password, ip) {
    this.checkRate(ip);
    const ok = this.validateName(name);
    if (!ok.ok) throw new AuthError('INVALID', ok.error);
    if (!password || String(password).length < 4) throw new AuthError('INVALID', '密码至少 4 个字符');
    if (String(password).length > 128) throw new AuthError('INVALID', '密码过长');
    if (this.byName.has(String(name).toLowerCase())) throw new AuthError('TAKEN', '这个昵称已经被注册了');

    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: 'u' + crypto.randomBytes(6).toString('hex'),
      name: String(name),
      salt,
      hash: this._hash(String(password), salt),
      color: this._pickColor(),
      guest: false,
      createdAt: Date.now(),
      lastSeen: Date.now(),
    };
    this.users.set(user.id, user);
    this.byName.set(user.name.toLowerCase(), user.id);
    const token = this._newToken(user.id);
    this.scheduleSave();
    return { token, user: this.publicUser(user) };
  }

  login(name, password, ip) {
    this.checkRate(ip);
    const id = this.byName.get(String(name || '').toLowerCase());
    const user = id ? this.users.get(id) : null;
    if (!user || user.guest) {
      this.noteFailure(ip);
      throw new AuthError('AUTH', '昵称或密码不正确');
    }
    const candidate = this._hash(String(password || ''), user.salt);
    const a = Buffer.from(candidate, 'hex');
    const b = Buffer.from(user.hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      this.noteFailure(ip);
      throw new AuthError('AUTH', '昵称或密码不正确');
    }
    this.loginFailures.delete(ip);
    user.lastSeen = Date.now();
    const token = this._newToken(user.id);
    this.scheduleSave();
    return { token, user: this.publicUser(user) };
  }

  guest(ip) {
    // 服务器关了游客通道：**直接拒绝**，既不发 token 也不建账号（HTTP 层会把它翻成 403）。
    // 消息与 server/index.js 的 GUEST_DISABLED_MESSAGE 保持一致（两处都在同一条用户可见文案上）。
    if (!this.allowGuests) {
      throw new AuthError('FORBIDDEN', '本服务器已关闭游客登录，请注册账号或使用已有账号登录');
    }
    this.checkRate(ip, 60);
    for (let i = 0; i < 50; i++) {
      const name = '游客' + crypto.randomInt(1000, 9999);
      if (this.byName.has(name.toLowerCase())) continue;
      const user = {
        id: 'g' + crypto.randomBytes(6).toString('hex'),
        name,
        salt: '',
        hash: '',
        color: this._pickColor(),
        guest: true,
        createdAt: Date.now(),
        lastSeen: Date.now(),
      };
      this.users.set(user.id, user);
      this.byName.set(name.toLowerCase(), user.id);
      const token = this._newToken(user.id);
      this.scheduleSave();
      return { token, user: this.publicUser(user) };
    }
    throw new AuthError('SERVER', '游客名额暂时用完了，请稍后再试');
  }

  validateName(name) {
    const s = String(name == null ? '' : name).trim();
    if (!s) return { ok: false, error: '昵称不能为空' };
    if (s.length > 16) return { ok: false, error: '昵称最长 16 个字符' };
    if (!NAME_RE.test(s)) return { ok: false, error: '昵称只能包含中英文、数字、下划线和短横线' };
    return { ok: true };
  }

  checkRate(ip, max = 20) {
    const rec = this.loginFailures.get(ip);
    if (rec && rec.count >= max && Date.now() < rec.until) {
      throw new AuthError('RATELIMIT', '尝试太频繁了，请稍后再试');
    }
  }

  noteFailure(ip) {
    const rec = this.loginFailures.get(ip) || { count: 0, until: 0 };
    rec.count += 1;
    rec.until = Date.now() + 60 * 1000;
    this.loginFailures.set(ip, rec);
    if (this.loginFailures.size > 5000) this.loginFailures.clear();
  }

  userByToken(token) {
    if (!token) return null;
    const rec = this.tokens.get(token);
    if (!rec) return null;
    if (rec.exp <= Date.now()) {
      this.tokens.delete(token);
      this.scheduleSave();
      return null;
    }
    const user = this.users.get(rec.userId);
    if (!user) return null;
    user.lastSeen = Date.now();
    return user;
  }

  logout(token) {
    if (this.tokens.delete(token)) this.scheduleSave();
  }

  publicUser(user) {
    return { id: user.id, name: user.name, color: user.color, guest: !!user.guest };
  }

  prune() {
    const before = this.tokens.size;
    this._pruneTokens();
    if (this.tokens.size !== before) this.scheduleSave();
  }

  shutdown() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    this._pruneTokens();
    this.save();
  }
}

module.exports = { Auth, AuthError };
