const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { SMSProvider } = require('../src/smsProvider');
const { MailProvider } = require('../src/mailProvider');
const { normalizePhoneCountries, DEFAULT_PHONE_COUNTRIES } = require('../src/phoneCountryCatalog');

const projectRoot = path.resolve(__dirname, '..');
const configPath = path.join(projectRoot, 'config.json');
const statsBaselinePath = path.join(projectRoot, 'desktop-stats-baseline.json');
const tokenStatusPath = path.join(projectRoot, 'token-status.json');
let mainWindow = null;
let activeRun = null;
let runStartedAt = null;
let lastLogLines = [];

const HERO_SMS_COUNTRY_META = {
  4: { isoCode: 'PH', dialCode: '63', name: '菲律宾' },
  6: { isoCode: 'ID', dialCode: '62', name: '印度尼西亚' },
  16: { isoCode: 'GB', dialCode: '44', name: '英国' },
  31: { isoCode: 'ZA', dialCode: '27', name: '南非' },
  33: { isoCode: 'CO', dialCode: '57', name: '哥伦比亚' },
  39: { isoCode: 'AR', dialCode: '54', name: '阿根廷' },
  50: { isoCode: 'AT', dialCode: '43', name: '奥地利' },
  73: { isoCode: 'BR', dialCode: '55', name: '巴西' },
  117: { isoCode: 'PT', dialCode: '351', name: '葡萄牙' },
  151: { isoCode: 'CL', dialCode: '56', name: '智利' },
  187: { isoCode: 'US', dialCode: '1', name: '美国' },
};

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function safeConfig(config = {}) {
  return {
    heroSmsApiKey: config.heroSmsApiKey || '',
    heroSmsService: config.heroSmsService || 'dr',
    heroSmsCountry: Number(config.heroSmsCountry) || 16,
    heroSmsPromptCountrySelection: config.heroSmsPromptCountrySelection !== false,
    heroSmsCountryTopN: Number(config.heroSmsCountryTopN) || 10,
    phoneCountryCode: String(config.phoneCountryCode || 'GB').toUpperCase(),
    phoneCountries: Array.isArray(config.phoneCountries) ? config.phoneCountries : DEFAULT_PHONE_COUNTRIES,
    mailProvider: config.mailProvider || 'cloudflare-worker',
    mailBaseUrl: config.mailBaseUrl || '',
    mailAdminToken: config.mailAdminToken || '',
    mailAdminPassword: config.mailAdminPassword || '',
    mailSitePassword: config.mailSitePassword || '',
    mailAdminEmail: config.mailAdminEmail || '',
    mailDomain: config.mailDomain || '',
    mailDomains: Array.isArray(config.mailDomains) ? config.mailDomains : [],
    proxyHost: config.proxyHost || '',
    proxyPort: Number(config.proxyPort) || 0,
    proxyUsername: config.proxyUsername || '',
    proxyPassword: config.proxyPassword || '',
    useChrome: config.useChrome !== false,
    chromePath: config.chromePath || '',
    browserUserDataDir: config.browserUserDataDir || 'browser-profile',
    browserIncognito: config.browserIncognito === true,
    browserClearChatGptSession: config.browserClearChatGptSession === true,
    targetTokenCount: Math.max(1, Math.min(100, Math.floor(Number(config.targetTokenCount) || 1))),
    tokenOutputDir: config.tokenOutputDir || 'tokens',
    tokenOutputDirs: Array.isArray(config.tokenOutputDirs) ? config.tokenOutputDirs : ['tokens'],
  };
}

function getTokenDir(config) {
  return path.resolve(projectRoot, config.tokenOutputDir || 'tokens');
}

function getTokenDirs(config) {
  const dirs = Array.isArray(config.tokenOutputDirs) && config.tokenOutputDirs.length
    ? config.tokenOutputDirs
    : [config.tokenOutputDir || 'tokens'];
  return [...new Set(dirs.map(dir => path.resolve(projectRoot, dir || 'tokens')))];
}

function listTokenFiles(config) {
  const seen = new Set();
  const files = [];
  for (const dir of getTokenDirs(config)) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!/^codex-.*-free\.json$/.test(file)) continue;
      const fullPath = path.join(dir, file);
      if (seen.has(fullPath)) continue;
      seen.add(fullPath);
      files.push(fullPath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function countTokenFiles(config) {
  return listTokenFiles(config).length;
}

function getRawCounts(config) {
  const accounts = readJson(path.join(projectRoot, 'accounts.json'), []);
  const usernames = readJson(path.join(projectRoot, 'username.json'), []);
  return {
    accounts: Array.isArray(accounts) ? accounts.length : 0,
    usernames: Array.isArray(usernames) ? usernames.length : 0,
    tokens: countTokenFiles(config),
  };
}

function getStatsBaseline() {
  const baseline = readJson(statsBaselinePath, {});
  return {
    usernames: Math.max(0, Math.floor(Number(baseline.usernames) || 0)),
    tokens: Math.max(0, Math.floor(Number(baseline.tokens) || 0)),
  };
}

function getDisplayCounts(config) {
  const raw = getRawCounts(config);
  const baseline = getStatsBaseline();
  return {
    accounts: raw.accounts,
    usernames: Math.max(0, raw.usernames - baseline.usernames),
    tokens: Math.max(0, raw.tokens - baseline.tokens),
    raw,
    baseline,
  };
}

function emit(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function appendLog(source, text) {
  const normalized = String(text || '').replace(/\r/g, '').split('\n').filter(Boolean);
  for (const line of normalized) {
    const item = { at: new Date().toISOString(), source, line };
    lastLogLines.push(item);
    if (lastLogLines.length > 800) lastLogLines.shift();
    emit('runtime:log', item);
  }
}

function getNodeCommand() {
  return process.env.GPT_REGISTER_NODE || 'node';
}

function summarizeError(error) {
  const status = error?.response?.status;
  const body = error?.response?.data;
  let detail = '';
  if (body) {
    detail = typeof body === 'string' ? body : JSON.stringify(body);
    if (detail.length > 600) detail = `${detail.slice(0, 600)}...`;
  }
  return { ok: false, status, code: error?.code || '', message: error?.message || String(error), detail };
}

function parseJwtPayload(token) {
  try {
    const [, payload] = String(token || '').split('.');
    if (!payload) return null;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (_error) {
    return null;
  }
}

function tokenEmailFromFile(filePath, token = {}) {
  const jwtPayload = parseJwtPayload(token.access_token);
  const profile = jwtPayload?.['https://api.openai.com/profile'];
  const fromJwt = profile?.email || jwtPayload?.email;
  if (fromJwt) return fromJwt;
  if (token.email) return token.email;
  const file = path.basename(filePath);
  const match = file.match(/^codex-(.*)-free\.json$/);
  return match ? match[1] : file;
}

function tokenExpiryMs(token = {}) {
  const explicit = token.expires_at || token.expiresAt || token.expired_time || token.expiredTime || token.expired || token.expires;
  if (explicit) {
    const parsed = typeof explicit === 'number'
      ? (explicit < 10_000_000_000 ? explicit * 1000 : explicit)
      : Date.parse(explicit);
    if (Number.isFinite(parsed)) return parsed;
  }
  const jwtPayload = parseJwtPayload(token.access_token);
  if (Number.isFinite(Number(jwtPayload?.exp))) return Number(jwtPayload.exp) * 1000;
  return 0;
}

function classifyTokenFile(filePath) {
  try {
    const token = readJson(filePath, null);
    if (!token || typeof token !== 'object') {
      return { email: path.basename(filePath), status: '未知', error: 'token 文件不是有效 JSON' };
    }
    const email = tokenEmailFromFile(filePath, token);
    const expiresAtMs = tokenExpiryMs(token);
    if (!token.access_token) {
      return { email, status: '未知', error: '缺少 access_token' };
    }
    if (!expiresAtMs) {
      return { email, status: '未知', error: '无法解析过期时间' };
    }
    if (expiresAtMs <= Date.now()) {
      return {
        email,
        status: token.refresh_token ? '已过期' : '刷新失败',
        error: token.refresh_token ? 'access_token 已过期，等待刷新验证' : 'access_token 已过期且缺少 refresh_token',
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    }
    return { email, status: '可用', error: '', expiresAt: new Date(expiresAtMs).toISOString() };
  } catch (error) {
    return { email: path.basename(filePath), status: '未知', error: error.message || String(error) };
  }
}

async function requestWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function refreshExpiredToken(filePath, row) {
  const token = readJson(filePath, null);
  if (!token?.refresh_token) return row;
  const clientId = token.client_id || token.clientId || 'app_EMoamEEZ73f0CkXAXp7hrann';
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
  });
  try {
    const response = await requestWithTimeout('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { ...row, status: '刷新失败', error: `刷新接口返回 ${response.status}${text ? `：${text.slice(0, 160)}` : ''}` };
    }
    const refreshed = await response.json();
    if (!refreshed.access_token) {
      return { ...row, status: '刷新失败', error: '刷新成功响应缺少 access_token' };
    }
    const next = {
      ...token,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token || token.refresh_token,
      id_token: refreshed.id_token || token.id_token,
      expires_in: refreshed.expires_in || token.expires_in,
      updated_at: new Date().toISOString(),
    };
    writeJson(filePath, next);
    const checked = classifyTokenFile(filePath);
    return { ...checked, file: path.basename(filePath), filePath, checkedAt: new Date().toISOString(), error: checked.error || '' };
  } catch (error) {
    const code = error?.name === 'AbortError' ? 'TIMEOUT' : error?.code;
    return { ...row, status: '接口不可用', error: code ? `${code}: ${error.message}` : error.message || String(error) };
  }
}

async function getTokenStatusOverview(config) {
  const files = listTokenFiles(config);
  const rows = [];
  for (const filePath of files) {
    const classified = classifyTokenFile(filePath);
    let row = {
      ...classified,
      file: path.basename(filePath),
      filePath,
      checkedAt: new Date().toISOString(),
      error: classified.error || '',
    };
    if (classified.status === '已过期') {
      row = await refreshExpiredToken(filePath, row);
    }
    rows.push(row);
  }
  const counts = rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});
  const result = { ok: true, rows, counts, total: rows.length, refreshedAt: new Date().toISOString() };
  writeJson(tokenStatusPath, result);
  return result;
}

function validateConfig(config) {
  const issues = [];
  if (!config.heroSmsApiKey) issues.push('HeroSMS API Key 为空');
  if (!config.mailBaseUrl) issues.push('邮箱接口地址为空');
  if (!config.mailDomain && (!Array.isArray(config.mailDomains) || config.mailDomains.length === 0)) issues.push('邮箱域名为空');
  if (['cloudflare-worker', 'cloud-mail'].includes(String(config.mailProvider || '').toLowerCase()) && !config.mailAdminToken && !config.mailAdminPassword) {
    issues.push('邮箱接口 Token/管理员密码为空');
  }
  if (config.useChrome && !config.chromePath) issues.push('Chrome 路径为空');
  return issues;
}

async function getHeroSmsOverview(config) {
  if (!config.heroSmsApiKey) return { ok: false, message: 'HeroSMS API Key 为空' };
  const provider = new SMSProvider(config.heroSmsApiKey);
  const service = config.heroSmsService || 'dr';
  const normalizedCountries = normalizePhoneCountries(Array.isArray(config.phoneCountries) && config.phoneCountries.length ? config.phoneCountries : DEFAULT_PHONE_COUNTRIES);
  const balanceRaw = await provider.request('getBalance');
  const balanceMatch = String(balanceRaw || '').match(/[-+]?\d+(?:\.\d+)?/);
  let priced = [];
  try {
    const apiCountries = await provider.getCountries();
    const byId = new Map(normalizedCountries.filter(c => c.heroSmsCountry).map(c => [Number(c.heroSmsCountry), c]));
    const usable = apiCountries.length
      ? apiCountries.map(c => {
        const heroId = Number(c.heroSmsCountry);
        const local = byId.get(heroId) || HERO_SMS_COUNTRY_META[heroId];
        return local ? { ...c, ...local, apiName: c.name || c.country || c.countryName || '' } : c;
      })
      : normalizedCountries;
    priced = await provider.listCountryPrices(service, usable.filter(c => c.heroSmsCountry));
  } catch (error) {
    priced = await provider.getTopCountriesByService(service).catch(() => []);
  }
  return {
    ok: true,
    balanceRaw,
    balance: balanceMatch ? Number(balanceMatch[0]) : null,
    service,
    countryCount: priced.length,
    countries: priced.slice(0, 160),
    refreshedAt: new Date().toISOString(),
  };
}

async function testMail(config) {
  const domain = String(config.mailDomain || (config.mailDomains || [])[0] || '').replace(/^@/, '');
  if (!config.mailBaseUrl || !domain) return { ok: false, message: '邮箱接口地址或域名为空' };
  const proxy = config.proxyHost ? {
    host: config.proxyHost,
    port: Number(config.proxyPort) || 0,
    username: config.proxyUsername || '',
    password: config.proxyPassword || '',
  } : null;
  const mail = new MailProvider({
    baseUrl: config.mailBaseUrl,
    provider: config.mailProvider,
    adminToken: config.mailAdminToken,
    adminPassword: config.mailAdminPassword || config.mailAdminToken,
    sitePassword: config.mailSitePassword,
    adminEmail: config.mailAdminEmail,
    domain,
    proxy,
  });
  const created = await mail.createAddress(`desktop${Date.now()}`);
  const mails = await mail.getMailsByAddress(created.address, 1, 0).catch(() => []);
  return { ok: true, address: created.address, inboxReachable: Array.isArray(mails), count: mails.length };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 700,
    title: 'GPT注册桌面控制台',
    backgroundColor: '#eef7f4',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (activeRun) {
    appendLog('system', '桌面窗口关闭，正在停止当前任务');
    activeRun.kill('SIGTERM');
  }
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('app:summary', async () => {
  const config = safeConfig(readJson(configPath, {}));
  return { projectRoot, configPath, config, issues: validateConfig(config), counts: getDisplayCounts(config), isRunning: !!activeRun, logs: lastLogLines };
});

ipcMain.handle('stats:reset', async () => {
  const config = safeConfig(readJson(configPath, {}));
  const raw = getRawCounts(config);
  const baseline = {
    usernames: raw.usernames,
    tokens: raw.tokens,
    resetAt: new Date().toISOString(),
  };
  writeJson(statsBaselinePath, baseline);
  appendLog('system', `统计已归零：邮箱记录 ${raw.usernames}，Token ${raw.tokens}。文件未删除。`);
  return { ok: true, counts: getDisplayCounts(config) };
});

ipcMain.handle('config:save', async (_event, incoming) => {
  const current = readJson(configPath, {});
  const next = safeConfig({ ...current, ...incoming });
  writeJson(configPath, next);
  return { ok: true, config: next, issues: validateConfig(next) };
});

ipcMain.handle('config:open-folder', async () => {
  await shell.openPath(projectRoot);
  return { ok: true };
});

ipcMain.handle('token:open-dir', async () => {
  const config = safeConfig(readJson(configPath, {}));
  const dir = getTokenDir(config);
  fs.mkdirSync(dir, { recursive: true });
  await shell.openPath(dir);
  return { ok: true, dir };
});

ipcMain.handle('token:status', async () => {
  try {
    const config = safeConfig(readJson(configPath, {}));
    return await getTokenStatusOverview(config);
  } catch (error) {
    return summarizeError(error);
  }
});

ipcMain.handle('herosms:overview', async () => {
  try {
    const config = safeConfig(readJson(configPath, {}));
    return await getHeroSmsOverview(config);
  } catch (error) {
    return summarizeError(error);
  }
});

ipcMain.handle('mail:test', async () => {
  try {
    const config = safeConfig(readJson(configPath, {}));
    return await testMail(config);
  } catch (error) {
    return summarizeError(error);
  }
});

ipcMain.handle('runtime:start', async (_event, options = {}) => {
  if (activeRun) return { ok: false, message: '已有任务正在运行，请先停止或等待完成' };
  const config = safeConfig(readJson(configPath, {}));
  const issues = validateConfig(config);
  if (issues.length) return { ok: false, message: issues.join('；') };

  fs.mkdirSync(getTokenDir(config), { recursive: true });

  const args = ['index.js'];
  const mode = String(options.mode || 'full');
  if (mode === 'phase2') args.push('--phase2');
  if (mode === 'phase3') args.push('--phase3');
  if (mode === 'phase8') args.push('--phase8');
  if (options.stopAfterPhase2) args.push('--stop-after-phase2');
  if (options.country) args.push(`--country=${String(options.country).toUpperCase()}`);
  const targetCount = Math.max(1, Math.min(100, Math.floor(Number(options.targetCount || config.targetTokenCount) || 1)));
  args.push(String(targetCount));

  lastLogLines = [];
  runStartedAt = Date.now();
  activeRun = spawn(getNodeCommand(), args, { cwd: projectRoot, env: { ...process.env, FORCE_COLOR: '0' }, windowsHide: false });
  const pid = activeRun.pid;
  appendLog('system', `任务已启动，PID=${pid}`);
  activeRun.stdout.on('data', data => appendLog('stdout', data.toString('utf8')));
  activeRun.stderr.on('data', data => appendLog('stderr', data.toString('utf8')));
  activeRun.on('error', error => {
    appendLog('system', `启动失败: ${error.message}`);
    emit('runtime:state', { isRunning: false, exitCode: null, message: error.message });
    activeRun = null;
  });
  activeRun.on('close', code => {
    const durationMs = runStartedAt ? Date.now() - runStartedAt : 0;
    appendLog('system', `任务结束，退出码=${code}，耗时=${Math.round(durationMs / 1000)}s`);
    activeRun = null;
    runStartedAt = null;
    emit('runtime:state', { isRunning: false, exitCode: code, durationMs });
  });
  emit('runtime:state', { isRunning: true, pid });
  return { ok: true, pid };
});

ipcMain.handle('runtime:stop', async () => {
  if (!activeRun) return { ok: true, message: '没有正在运行的任务' };
  const pid = activeRun.pid;
  appendLog('system', `用户请求停止任务，PID=${pid}`);
  activeRun.kill('SIGTERM');
  appendLog('system', `已发送停止信号，PID=${pid}`);
  return { ok: true };
});



