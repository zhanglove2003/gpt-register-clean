const api = window.desktopApi;
const state = {
  config: {},
  issues: [],
  counts: {},
  isRunning: false,
  logs: [],
  heroRows: [],
  tokenStatusRows: [],
  tokenStatusTimer: null,
  tokenStatusPending: false,
  refreshTimer: null,
  refreshPending: false,
};

const COUNTRY_ZH = {
  GB: '英国', US: '美国', CA: '加拿大', AU: '澳大利亚', NZ: '新西兰', IE: '爱尔兰',
  DE: '德国', FR: '法国', ES: '西班牙', IT: '意大利', NL: '荷兰', BE: '比利时',
  AT: '奥地利', CH: '瑞士', SE: '瑞典', NO: '挪威', DK: '丹麦', FI: '芬兰',
  PL: '波兰', PT: '葡萄牙', CZ: '捷克', GR: '希腊', RO: '罗马尼亚', HU: '匈牙利',
  TR: '土耳其', IL: '以色列', AE: '阿联酋', SA: '沙特阿拉伯', SG: '新加坡',
  MY: '马来西亚', TH: '泰国', VN: '越南', PH: '菲律宾', ID: '印度尼西亚',
  IN: '印度', JP: '日本', KR: '韩国', HK: '中国香港', TW: '中国台湾',
  BR: '巴西', MX: '墨西哥', AR: '阿根廷', CL: '智利', CO: '哥伦比亚',
  PE: '秘鲁', ZA: '南非', EG: '埃及', NG: '尼日利亚', CN: '中国', RU: '俄罗斯',
  UA: '乌克兰', KZ: '哈萨克斯坦', PK: '巴基斯坦', BD: '孟加拉国'
};
const COUNTRY_EN_ZH = {
  'afghanistan': '阿富汗', 'albania': '阿尔巴尼亚', 'algeria': '阿尔及利亚', 'angola': '安哥拉',
  'argentina': '阿根廷', 'armenia': '亚美尼亚', 'australia': '澳大利亚', 'austria': '奥地利',
  'azerbaijan': '阿塞拜疆', 'bahrain': '巴林', 'bangladesh': '孟加拉国', 'belarus': '白俄罗斯',
  'belgium': '比利时', 'bolivia': '玻利维亚', 'bosnia and herzegovina': '波黑', 'brazil': '巴西',
  'bulgaria': '保加利亚', 'cambodia': '柬埔寨', 'cameroon': '喀麦隆', 'canada': '加拿大',
  'chile': '智利', 'china': '中国', 'colombia': '哥伦比亚', 'costa rica': '哥斯达黎加',
  'croatia': '克罗地亚', 'cyprus': '塞浦路斯', 'czech republic': '捷克', 'czechia': '捷克',
  'denmark': '丹麦', 'dominican republic': '多米尼加共和国', 'ecuador': '厄瓜多尔', 'egypt': '埃及',
  'estonia': '爱沙尼亚', 'ethiopia': '埃塞俄比亚', 'finland': '芬兰', 'france': '法国',
  'georgia': '格鲁吉亚', 'germany': '德国', 'ghana': '加纳', 'greece': '希腊',
  'guatemala': '危地马拉', 'hong kong': '中国香港', 'hungary': '匈牙利', 'india': '印度',
  'indonesia': '印度尼西亚', 'ireland': '爱尔兰', 'israel': '以色列', 'italy': '意大利',
  'japan': '日本', 'jordan': '约旦', 'kazakhstan': '哈萨克斯坦', 'kenya': '肯尼亚',
  'kuwait': '科威特', 'kyrgyzstan': '吉尔吉斯斯坦', 'laos': '老挝', 'latvia': '拉脱维亚',
  'lebanon': '黎巴嫩', 'lithuania': '立陶宛', 'luxembourg': '卢森堡', 'macau': '中国澳门',
  'malaysia': '马来西亚', 'mexico': '墨西哥', 'moldova': '摩尔多瓦', 'mongolia': '蒙古',
  'morocco': '摩洛哥', 'mozambique': '莫桑比克', 'myanmar': '缅甸', 'nepal': '尼泊尔',
  'netherlands': '荷兰', 'new zealand': '新西兰', 'nigeria': '尼日利亚', 'norway': '挪威',
  'oman': '阿曼', 'pakistan': '巴基斯坦', 'panama': '巴拿马', 'paraguay': '巴拉圭',
  'peru': '秘鲁', 'philippines': '菲律宾', 'poland': '波兰', 'portugal': '葡萄牙',
  'qatar': '卡塔尔', 'romania': '罗马尼亚', 'russia': '俄罗斯', 'russian federation': '俄罗斯',
  'saudi arabia': '沙特阿拉伯', 'senegal': '塞内加尔', 'serbia': '塞尔维亚', 'singapore': '新加坡',
  'slovakia': '斯洛伐克', 'slovenia': '斯洛文尼亚', 'south africa': '南非', 'south korea': '韩国',
  'spain': '西班牙', 'sri lanka': '斯里兰卡', 'sweden': '瑞典', 'switzerland': '瑞士',
  'taiwan': '中国台湾', 'tajikistan': '塔吉克斯坦', 'tanzania': '坦桑尼亚', 'thailand': '泰国',
  'tunisia': '突尼斯', 'turkey': '土耳其', 'turkmenistan': '土库曼斯坦', 'uganda': '乌干达',
  'ukraine': '乌克兰', 'united arab emirates': '阿联酋', 'uae': '阿联酋',
  'united kingdom': '英国', 'uk': '英国', 'great britain': '英国', 'britain': '英国',
  'united states': '美国', 'united states of america': '美国', 'usa': '美国', 'america': '美国',
  'uruguay': '乌拉圭', 'uzbekistan': '乌兹别克斯坦', 'venezuela': '委内瑞拉', 'vietnam': '越南',
  'zambia': '赞比亚', 'zimbabwe': '津巴布韦'
};

const HERO_ID_ZH = {
  4: '菲律宾', 6: '印度尼西亚', 16: '英国', 33: '哥伦比亚', 39: '阿根廷', 73: '巴西',
  117: '葡萄牙', 151: '智利', 187: '美国'
};
const HERO_ID_META = {
  4: { isoCode: 'PH', dialCode: '63' },
  6: { isoCode: 'ID', dialCode: '62' },
  16: { isoCode: 'GB', dialCode: '44' },
  31: { isoCode: 'ZA', dialCode: '27' },
  33: { isoCode: 'CO', dialCode: '57' },
  39: { isoCode: 'AR', dialCode: '54' },
  50: { isoCode: 'AT', dialCode: '43' },
  73: { isoCode: 'BR', dialCode: '55' },
  117: { isoCode: 'PT', dialCode: '351' },
  151: { isoCode: 'CL', dialCode: '56' },
  187: { isoCode: 'US', dialCode: '1' },
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function normalizeIso(value) {
  return String(value || '').trim().toUpperCase();
}

function countryIso(row = {}) {
  const heroId = Number(row.heroSmsCountry);
  return normalizeIso(row.isoCode || row.code || row.countryCode || row.iso || row.phoneCountryCode || HERO_ID_META[heroId]?.isoCode);
}

function countryDial(row = {}) {
  const heroId = Number(row.heroSmsCountry);
  return String(row.dialCode || row.phoneCode || row.prefix || HERO_ID_META[heroId]?.dialCode || '').replace(/^\+/, '').trim();
}

function normalizeCountryKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function countryName(row = {}) {
  const iso = countryIso(row);
  const englishKey = normalizeCountryKey(row.apiName || row.name || row.country || row.countryName);
  const heroId = Number(row.heroSmsCountry);
  return COUNTRY_ZH[iso]
    || COUNTRY_EN_ZH[englishKey]
    || HERO_ID_ZH[heroId]
    || row.nameZh
    || row.zhName
    || row.chineseName
    || row.nameCn
    || row.name
    || row.apiName
    || iso
    || '-';
}

function countryOptionLabel(country = {}) {
  const iso = countryIso(country);
  const name = countryName(country);
  const parts = [name];
  if (iso) parts.push(iso);
  if (country.dialCode) parts.push(`+${country.dialCode}`);
  if (country.heroSmsCountry !== undefined && country.heroSmsCountry !== null && country.heroSmsCountry !== '') parts.push(`ID ${country.heroSmsCountry}`);
  return parts.join(' · ');
}

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 3200);
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

function setView(view) {
  $$('.nav-item').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
  $$('.view').forEach(section => section.classList.toggle('active', section.id === `view-${view}`));
  const titles = {
    console: ['Console', '控制台'],
    config: ['Settings', '后台配置'],
    herosms: ['HeroSMS', 'HeroSMS 数据'],
    'token-status': ['Token Status', 'Token 状态'],
  };
  $('#viewEyebrow').textContent = titles[view][0];
  $('#viewTitle').textContent = titles[view][1];
  if (view === 'token-status') refreshTokenStatus().catch(error => console.warn(error));
}

function updateRunState(running) {
  state.isRunning = running;
  $('#runDot').classList.toggle('running', running);
  $('#runStateText').textContent = running ? '运行中' : '未运行';
  $('#statusPill').textContent = running ? '运行中' : '空闲';
  $('#statusPill').classList.toggle('running', running);
  $('#startBtn').disabled = running;
  $('#stopBtn').disabled = !running;
  scheduleLiveRefresh(running);
}

function updateSummaryUi(summary) {
  state.config = summary.config || {};
  state.issues = summary.issues || [];
  state.counts = summary.counts || {};
  $('#accountCount').textContent = state.counts.accounts ?? 0;
  $('#usernameCount').textContent = state.counts.usernames ?? 0;
  $('#tokenCount').textContent = state.counts.tokens ?? 0;
  $('#issueText').textContent = state.issues.length ? state.issues.join('；') : '配置可运行';
  updateRunState(!!summary.isRunning);
  const targetInput = document.querySelector('#targetTokenCount');
  if (targetInput && !summary.isRunning) targetInput.value = Math.max(1, Math.min(100, Math.floor(Number(state.config.targetTokenCount) || 1)));
  renderCountryOptions(state.config);
  fillConfigForm(state.config);
  state.logs = summary.logs || [];
  renderLogs();
}

function renderCountryOptions(config = {}) {
  const select = $('#runCountry');
  if (!select) return;
  const currentValue = normalizeIso(select.value);
  const configured = Array.isArray(config.phoneCountries) ? config.phoneCountries : [];
  const fallback = [
    { isoCode: 'PH', dialCode: '63', heroSmsCountry: 4 },
    { isoCode: 'GB', dialCode: '44', heroSmsCountry: 16 },
    { isoCode: 'BR', dialCode: '55', heroSmsCountry: 73 },
    { isoCode: 'ID', dialCode: '62', heroSmsCountry: 6 },
    { isoCode: 'CO', dialCode: '57', heroSmsCountry: 33 },
    { isoCode: 'CL', dialCode: '56', heroSmsCountry: 151 },
    { isoCode: 'AR', dialCode: '54', heroSmsCountry: 39 },
    { isoCode: 'PT', dialCode: '351', heroSmsCountry: 117 },
    { isoCode: 'ZA', dialCode: '27', heroSmsCountry: 31 },
    { isoCode: 'AT', dialCode: '43', heroSmsCountry: 50 },
    { isoCode: 'US', dialCode: '1', heroSmsCountry: 187 },
  ];
  const countries = configured.length ? configured : fallback;
  const seen = new Set();
  const options = countries
    .map(country => ({ ...country, isoCode: countryIso(country) }))
    .filter(country => country.isoCode && !seen.has(country.isoCode) && seen.add(country.isoCode));
  const selected = currentValue || normalizeIso(config.phoneCountryCode) || options[0]?.isoCode || 'GB';
  select.innerHTML = options.map(country => {
    const value = escapeHtml(country.isoCode);
    const label = escapeHtml(countryOptionLabel(country));
    return `<option value="${value}">${label}</option>`;
  }).join('');
  if (!options.some(country => country.isoCode === selected)) {
    select.insertAdjacentHTML('afterbegin', `<option value="${escapeHtml(selected)}">${escapeHtml(COUNTRY_ZH[selected] || selected)} · ${escapeHtml(selected)}</option>`);
  }
  select.value = selected;
}

function fillConfigForm(config) {
  const form = $('#configForm');
  for (const [key, value] of Object.entries(config)) {
    const input = form.elements[key];
    if (!input) continue;
    if (input.type === 'checkbox') {
      input.checked = !!value;
    } else {
      input.value = value ?? '';
    }
  }
}

function collectConfigForm() {
  const form = $('#configForm');
  const data = {};
  for (const element of [...form.elements]) {
    if (!element.name) continue;
    if (element.type === 'checkbox') data[element.name] = element.checked;
    else if (element.type === 'number') data[element.name] = Number(element.value) || 0;
    else data[element.name] = element.value.trim();
  }
  if (data.mailDomain) data.mailDomains = [data.mailDomain];
  return data;
}

function appendLog(item) {
  state.logs.push(item);
  if (state.logs.length > 800) state.logs.shift();
  renderLogs(true);
  if (/Token (成功保存|已保存)|token saved/i.test(item?.line || '')) {
    refreshSummary().catch(error => console.warn(error));
  }
}

function renderLogs(stickToBottom = false) {
  const box = $('#logBox');
  box.textContent = state.logs.map(item => `[${formatTime(item.at)}] ${item.source}: ${item.line}`).join('\n');
  if (stickToBottom) box.scrollTop = box.scrollHeight;
}

function renderHeroRows() {
  const query = $('#countryFilter').value.trim().toLowerCase();
  const rows = state.heroRows.filter(row => {
    const zhName = countryName(row);
    const haystack = [countryIso(row), zhName, row.name, row.apiName, row.heroSmsCountry, countryDial(row)].join(' ').toLowerCase();
    return !query || haystack.includes(query);
  });
  const tbody = $('#countryTable');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6">暂无数据</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(row => {
    const price = Number.isFinite(Number(row.price)) ? `$${Number(row.price).toFixed(3)}` : '-';
    const count = Number.isFinite(Number(row.count)) ? Number(row.count) : '-';
    const dial = countryDial(row);
    return `<tr><td>${escapeHtml(countryIso(row) || '-')}</td><td>${escapeHtml(countryName(row))}</td><td>${dial ? `+${escapeHtml(dial)}` : '-'}</td><td>${escapeHtml(row.heroSmsCountry ?? '-')}</td><td>${price}</td><td>${count}</td></tr>`;
  }).join('');
}

function statusClass(status) {
  if (status === '可用') return 'ok';
  if (status === '未知') return 'unknown';
  return 'bad';
}

function renderTokenStatusRows() {
  const tbody = $('#tokenStatusTable');
  if (!tbody) return;
  const rows = state.tokenStatusRows || [];
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4">暂无 Token 文件</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(row => {
    const status = row.status || '未知';
    const updated = row.checkedAt ? new Date(row.checkedAt).toLocaleString('zh-CN') : '-';
    return `<tr><td>${escapeHtml(row.email || '-')}</td><td><span class="token-badge ${statusClass(status)}">${escapeHtml(status)}</span></td><td>${escapeHtml(updated)}</td><td>${escapeHtml(row.error || '-')}</td></tr>`;
  }).join('');
}

function updateTokenStatusUi(result) {
  state.tokenStatusRows = result.rows || [];
  const counts = result.counts || {};
  const abnormal = (counts['已过期'] || 0) + (counts['刷新失败'] || 0) + (counts['接口不可用'] || 0);
  $('#tokenStatusTotal').textContent = result.total ?? state.tokenStatusRows.length;
  $('#tokenStatusOk').textContent = counts['可用'] || 0;
  $('#tokenStatusBad').textContent = abnormal;
  $('#tokenStatusUnknown').textContent = counts['未知'] || 0;
  $('#tokenStatusUpdated').textContent = result.refreshedAt
    ? `最后检测 ${new Date(result.refreshedAt).toLocaleString('zh-CN')}，每 10 秒自动刷新`
    : '每 10 秒自动刷新一次';
  renderTokenStatusRows();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

async function refreshSummary() {
  if (state.refreshPending) return;
  state.refreshPending = true;
  try {
    const summary = await api.getSummary();
    updateSummaryUi(summary);
  } finally {
    state.refreshPending = false;
  }
}

function scheduleLiveRefresh(running) {
  if (!running) {
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    state.refreshTimer = null;
    return;
  }
  if (state.refreshTimer) return;
  state.refreshTimer = setInterval(() => {
    refreshSummary().catch(error => console.warn(error));
  }, 3000);
}

async function refreshHeroSms() {
  $('#refreshHeroBtn').disabled = true;
  $('#testHeroBtn').disabled = true;
  try {
    const result = await api.getHeroSmsOverview();
    if (!result.ok) {
      toast(result.message || result.detail || 'HeroSMS 获取失败');
      return;
    }
    state.heroRows = result.countries || [];
    $('#heroBalance').textContent = result.balance === null ? result.balanceRaw || '-' : `$${Number(result.balance).toFixed(2)}`;
    $('#heroService').textContent = result.service || '-';
    $('#heroCountryCount').textContent = result.countryCount ?? state.heroRows.length;
    $('#heroUpdated').textContent = `最后刷新 ${new Date(result.refreshedAt).toLocaleString('zh-CN')}`;
    renderHeroRows();
    toast('HeroSMS 数据已刷新');
  } finally {
    $('#refreshHeroBtn').disabled = false;
    $('#testHeroBtn').disabled = false;
  }
}

async function refreshTokenStatus({ silent = false } = {}) {
  if (state.tokenStatusPending) return;
  state.tokenStatusPending = true;
  const btn = $('#refreshTokenStatusBtn');
  if (btn) btn.disabled = true;
  try {
    const result = await api.getTokenStatus();
    if (!result.ok) {
      if (!silent) toast(result.message || result.detail || 'Token 状态检测失败');
      return;
    }
    updateTokenStatusUi(result);
    if (!silent) toast('Token 状态已刷新');
  } finally {
    state.tokenStatusPending = false;
    if (btn) btn.disabled = false;
  }
}

async function testMail() {
  $('#testMailBtn').disabled = true;
  try {
    const result = await api.testMail();
    if (result.ok) toast(`邮箱接口正常：${result.address}`);
    else toast(result.message || result.detail || '邮箱接口测试失败');
  } finally {
    $('#testMailBtn').disabled = false;
  }
}

function getTargetTokenCount() {
  const input = document.querySelector('#targetTokenCount');
  const raw = Number(input?.value || 1);
  if (!Number.isFinite(raw)) return 1;
  return Math.max(1, Math.min(100, Math.floor(raw)));
}

async function startRun() {
  const selectedCountry = document.querySelector('#runCountry').value;
  if (selectedCountry && selectedCountry !== state.config.phoneCountryCode) {
    await api.saveConfig({ phoneCountryCode: selectedCountry });
    state.config.phoneCountryCode = selectedCountry;
  }
  const options = {
    mode: document.querySelector('#runMode').value,
    country: selectedCountry,
    targetCount: getTargetTokenCount(),
    stopAfterPhase2: document.querySelector('#stopAfterPhase2').checked,
  };
  const result = await api.startRun(options);
  if (!result.ok) {
    toast(result.message || '任务启动失败');
    return;
  }
  updateRunState(true);
  toast(`任务已启动，PID=${result.pid}，目标总数=${options.targetCount}`);
}
async function stopRun() {
  const result = await api.stopRun();
  toast(result.message || '已请求停止任务');
}

async function openTokenDir() {
  const result = await api.openTokenDir();
  if (result.ok) toast('Token 目录已打开');
  else toast(result.message || 'Token 目录打开失败');
}

async function resetStats() {
  const confirmed = window.confirm('将邮箱记录和 Token 显示数量归零，不会删除任何 token 文件。继续吗？');
  if (!confirmed) return;
  const result = await api.resetStats();
  if (result.ok) {
    state.counts = result.counts || {};
    $('#usernameCount').textContent = state.counts.usernames ?? 0;
    $('#tokenCount').textContent = state.counts.tokens ?? 0;
    toast('统计数字已归零，文件未删除');
    await refreshSummary();
  } else {
    toast(result.message || '统计归零失败');
  }
}

function bindEvents() {
  $$('.nav-item').forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));
  $('#refreshBtn').addEventListener('click', refreshSummary);
  $('#openFolderBtn').addEventListener('click', () => api.openProjectFolder());
  $('#startBtn').addEventListener('click', startRun);
  $('#stopBtn').addEventListener('click', stopRun);
  const tokenDirBtn = $('#openTokenDirBtn');
  if (tokenDirBtn) tokenDirBtn.addEventListener('click', openTokenDir);
  const resetStatsBtn = $('#resetStatsBtn');
  if (resetStatsBtn) resetStatsBtn.addEventListener('click', resetStats);
  $('#clearLogBtn').addEventListener('click', () => { state.logs = []; renderLogs(); });
  $('#refreshHeroBtn').addEventListener('click', refreshHeroSms);
  $('#refreshTokenStatusBtn').addEventListener('click', () => refreshTokenStatus());
  $('#testHeroBtn').addEventListener('click', refreshHeroSms);
  $('#testMailBtn').addEventListener('click', testMail);
  $('#countryFilter').addEventListener('input', renderHeroRows);
  $('#configForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('#configResult').textContent = '保存中';
    const result = await api.saveConfig(collectConfigForm());
    if (result.ok) {
      state.config = result.config;
      state.issues = result.issues || [];
      $('#issueText').textContent = state.issues.length ? state.issues.join('；') : '配置可运行';
      const targetInput = document.querySelector('#targetTokenCount');
      if (targetInput) targetInput.value = Math.max(1, Math.min(100, Math.floor(Number(state.config.targetTokenCount) || 1)));
      renderCountryOptions(state.config);
      $('#configResult').textContent = '已保存';
      toast('配置已保存');
    } else {
      $('#configResult').textContent = '保存失败';
      toast(result.message || '保存失败');
    }
  });
  api.onRuntimeLog(appendLog);
  api.onRuntimeState((payload) => {
    updateRunState(!!payload.isRunning);
    if (!payload.isRunning) refreshSummary();
  });
}

window.__setDesktopView = setView;

async function boot() {
  bindEvents();
  await refreshSummary();
  const initialView = ['console', 'config', 'herosms', 'token-status'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'console';
  setView(initialView);
  await refreshTokenStatus({ silent: true });
  state.tokenStatusTimer = setInterval(() => {
    refreshTokenStatus({ silent: true }).catch(error => console.warn(error));
  }, 10000);
  window.__desktopBootDone = true;
}

boot().catch(error => toast(error.message || String(error)));







