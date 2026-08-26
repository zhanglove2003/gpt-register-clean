const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const config = require('./config');

const SLEEP = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseProxyEndpoint(endpoint) {
    if (!endpoint || typeof endpoint !== 'string') return null;
    const raw = endpoint.trim();
    if (!raw) return null;

    try {
        const withScheme = raw.includes('://') ? raw : `http://${raw}`;
        const u = new URL(withScheme);

        const supportedProtocols = ['http:', 'https:', 'socks:', 'socks4:', 'socks5:'];
        if (!supportedProtocols.includes(u.protocol)) {
            return null;
        }

        const port = parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 80);
        if (!u.hostname || !port) return null;

        return {
            protocol: u.protocol,
            host: u.hostname,
            port,
            username: decodeURIComponent(u.username || ''),
            password: decodeURIComponent(u.password || ''),
        };
    } catch (e) {
        return null;
    }
}

function detectProxyFromEnv() {
    const env = process.env;
    const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
    if (!raw) return null;

    const parsed = parseProxyEndpoint(raw);
    if (!parsed) return null;

    return { ...parsed, source: 'env' };
}

function parseWinHttpProxyText(text) {
    if (!text) return null;

    // 优先提取 https=...;http=... 形式
    const httpsMatch = text.match(/https\s*=\s*([^;\s\r\n]+)/i);
    const httpMatch = text.match(/http\s*=\s*([^;\s\r\n]+)/i);
    const endpoint = (httpsMatch && httpsMatch[1]) || (httpMatch && httpMatch[1]);
    if (endpoint) return endpoint;

    // 兼容 "Proxy Server(s) : host:port" 形式
    const lineMatch = text.match(/Proxy\s*Server\(s\)\s*:\s*([^\r\n]+)/i);
    if (lineMatch && lineMatch[1]) {
        const value = lineMatch[1].trim();
        if (value && !/direct access|no proxy/i.test(value)) return value;
    }

    // 兜底：抓第一个 host:port
    const hostPort = text.match(/([a-zA-Z0-9.-]+:\d{2,5})/);
    if (hostPort && hostPort[1]) return hostPort[1];

    return null;
}

function detectProxyFromWinHttp() {
    if (process.platform !== 'win32') return null;

    try {
        const out = execSync('netsh winhttp show proxy', {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
        });

        const endpoint = parseWinHttpProxyText(out);
        if (!endpoint) return null;

        const parsed = parseProxyEndpoint(endpoint);
        if (!parsed) return null;

        return { ...parsed, source: 'winhttp' };
    } catch (e) {
        return null;
    }
}

function detectSystemProxy() {
    return detectProxyFromEnv() || detectProxyFromWinHttp();
}

function buildProxyUrl(proxy) {
    if (!proxy?.host || !proxy?.port) return '';

    const protocol = proxy.protocol || 'http:';
    const auth = proxy.username || proxy.password
        ? `${encodeURIComponent(proxy.username || '')}:${encodeURIComponent(proxy.password || '')}@`
        : '';
    return `${protocol}//${auth}${proxy.host}:${proxy.port}`;
}

function buildAxiosTransportConfig(proxy) {
    if (!proxy?.host || !proxy?.port) return {};

    const proxyUrl = buildProxyUrl(proxy);
    if (!proxyUrl) return {};

    const isSocks = String(proxy.protocol || '').startsWith('socks');
    const agent = isSocks
        ? new SocksProxyAgent(proxyUrl)
        : new HttpsProxyAgent(proxyUrl);

    return {
        proxy: false,
        httpAgent: agent,
        httpsAgent: agent,
    };
}

class OAuthService {
    constructor(options = {}) {
        this.clientId = 'app_EMoamEEZ73f0CkXaXp7hrann';
        this.redirectPort = 1455;
        this.redirectUri = `http://localhost:${this.redirectPort}/auth/callback`;
        this.proxy = options.proxy || detectSystemProxy() || null;
        this.codeVerifier = null;
        this.codeChallenge = null;
        this.state = null;

        if (this.proxy && this.proxy.host && this.proxy.port) {
            const source = this.proxy.source ? ` (${this.proxy.source})` : '';
            const protocol = this.proxy.protocol ? `${this.proxy.protocol}//` : '';
            console.log(`[OAuth] oauth/token 使用代理: ${protocol}${this.proxy.host}:${this.proxy.port}${source}`);
        }

        this.regeneratePKCE();
    }

    /**
     * 生成 Code Verifier
     */
    generateCodeVerifier() {
        return crypto.randomBytes(32).toString('base64url');
    }

    /**
     * 生成 Code Challenge
     */
    generateCodeChallenge(verifier) {
        return crypto.createHash('sha256').update(verifier).digest('base64url');
    }

    /**
     * 重新生成 PKCE 参数和 state
     */
    regeneratePKCE() {
        this.codeVerifier = this.generateCodeVerifier();
        this.codeChallenge = this.generateCodeChallenge(this.codeVerifier);
        this.state = crypto.randomBytes(16).toString('hex');
        console.log('[OAuth] 已重新生成 PKCE 参数和 state');
    }

    /**
     * 获取 OAuth 授权 URL
     * @returns {string} 授权 URL
     */
    getAuthUrl() {
        const params = new URLSearchParams({
            client_id: this.clientId,
            code_challenge: this.codeChallenge,
            code_challenge_method: 'S256',
            codex_cli_simplified_flow: 'true',
            id_token_add_organizations: 'true',
            prompt: 'login',
            redirect_uri: this.redirectUri,
            response_type: 'code',
            scope: 'openid email profile offline_access',
            state: this.state
        });
        return `https://auth.openai.com/oauth/authorize?${params.toString()}`;
    }

    /**
     * 从 localhost 回调 URL 中提取授权参数
     * @param {string} callbackUrl - 完整的回调 URL
     * @returns {object|null} 提取的参数对象
     */
    extractCallbackParams(callbackUrl) {
        try {
            const url = new URL(callbackUrl);
            const params = {
                code: url.searchParams.get('code'),
                state: url.searchParams.get('state'),
                error: url.searchParams.get('error'),
                error_description: url.searchParams.get('error_description')
            };

            // 验证 state
            if (params.state && params.state !== this.state) {
                console.error('[OAuth] State 不匹配:', params.state, '期望:', this.state);
                return null;
            }

            return params;
        } catch (e) {
            console.error('[OAuth] 解析回调 URL 失败:', e.message);
            return null;
        }
    }

    /**
     * 用授权码换取 Token
     * @param {string} code - 授权码
     * @param {string} email - 邮箱地址
     * @returns {Promise<object>} Token 对象
     */
    async exchangeTokenAndSave(code, email) {
        try {
            console.log('[OAuth] 开始用 code 换取 Token');

            const body = new URLSearchParams({
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: this.redirectUri,
                client_id: this.clientId,
                code_verifier: this.codeVerifier
            }).toString();

            const maxAttempts = 5;
            let response = null;
            let lastError = null;

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    const requestConfig = {
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        timeout: 30000,
                    };

                    if (this.proxy && this.proxy.host && this.proxy.port) {
                        Object.assign(requestConfig, buildAxiosTransportConfig(this.proxy));
                    }

                    response = await axios.post('https://auth.openai.com/oauth/token', body, {
                        ...requestConfig,
                    });
                    break;
                } catch (err) {
                    lastError = err;

                    const status = err?.response?.status;
                    const code = err?.code;
                    const retryable =
                        code === 'EAI_AGAIN' ||
                        code === 'ENOTFOUND' ||
                        code === 'ECONNRESET' ||
                        code === 'ETIMEDOUT' ||
                        code === 'ECONNABORTED' ||
                        status === 429 ||
                        (status >= 500 && status <= 599);

                    if (!retryable || attempt === maxAttempts) {
                        throw err;
                    }

                    const waitMs = attempt * 3000;
                    console.warn(`[OAuth] 换 Token 第 ${attempt} 次失败(${code || status || 'unknown'})，${waitMs}ms 后重试...`);
                    await SLEEP(waitMs);
                }
            }

            if (!response) {
                throw lastError || new Error('换取 Token 失败: 未获得响应');
            }

            const tokens = response.data;

            // 解析 JWT 获取 account_id
            let accountId = "";
            try {
                const payloadStr = Buffer.from(tokens.access_token.split('.')[1], 'base64').toString('utf8');
                const payload = JSON.parse(payloadStr);
                const apiAuth = payload['https://api.openai.com/auth'] || {};
                accountId = apiAuth.chatgpt_account_id || "";
            } catch (e) {
                console.error('[OAuth] 解析 access_token 获取 account_id 失败:', e.message);
            }

            const now = new Date();
            const expiredTime = new Date(now.getTime() + tokens.expires_in * 1000);

            const outData = {
                access_token: tokens.access_token,
                account_id: accountId,
                disabled: false,
                email: email,
                expired: expiredTime.toISOString().replace(/\.[0-9]{3}Z$/, '+08:00'),
                id_token: tokens.id_token,
                last_refresh: now.toISOString().replace(/\.[0-9]{3}Z$/, '+08:00'),
                refresh_token: tokens.refresh_token,
                type: 'codex'
            };

            // 保存到文件（支持双写/多目录）
            const outputDirs = config.tokenOutputDirs.length > 0
                ? [...new Set(config.tokenOutputDirs)]
                : [config.tokenOutputDir || path.join(process.cwd(), 'tokens')];
            const safeEmail = String(email || 'unknown')
                .trim()
                .replace(/[\\/:*?"<>|]/g, '_');
            const filename = `codex-${safeEmail}-free.json`;
            const savedPaths = [];
            const safeFilename = path.basename(filename);
            for (const dir of outputDirs) {
                // 允许根：配置的目录（视为绝对路径或相对当前工作目录）
                const allowRoot = path.resolve(process.cwd(), String(dir || ''));
                // 边界校验：拒绝任何含 `..` 或非绝对形式的目录，确保不会越出配置范围
                if (!String(dir).trim() || String(dir).split(/[\\/]+/).includes('..')) continue;
                fs.mkdirSync(allowRoot, { recursive: true });
                const filepath = path.join(allowRoot, safeFilename);
                // 最终再校验一次：写入路径必须仍位于允许根内
                if (path.resolve(filepath) !== allowRoot && !path.resolve(filepath).startsWith(allowRoot + path.sep)) continue;
                fs.writeFileSync(filepath, JSON.stringify(outData, null, 2));
                savedPaths.push(filepath);
            }

            console.log(`[OAuth] Token 成功保存至: ${savedPaths.join(' | ')}`);
            return outData;
        } catch (error) {
            const apiErrorCode = error?.response?.data?.error?.code;
            if (apiErrorCode === 'unsupported_country_region_territory') {
                console.error('[OAuth] 地区受限：当前出口 IP 不支持，请配置可用代理后重试');
            }
            console.error('[OAuth] 换取 Token 失败:', error.response ? error.response.data : error.message);
            throw error;
        }
    }
}

module.exports = { OAuthService };
