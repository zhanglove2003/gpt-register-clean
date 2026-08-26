const axios = require('axios');

class SMSProvider {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://hero-sms.com/stubs/handler_api.php';
        this.activationId = null;
        this.phoneNumber = null;
    }

    /**
     * 发送 API 请求
     */
    async request(action, params = {}) {
        const response = await axios.get(this.baseUrl, {
            params: { api_key: this.apiKey, action, ...params },
            timeout: 30000,
        });
        return response.data;
    }

    isRetryableHttpError(error) {
        const status = Number(error?.response?.status || 0);
        return status >= 500 || ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED'].includes(error?.code);
    }

    async setStatusWithRetry(status, label, maxRetries = 3) {
        for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
            try {
                return await this.request('setStatus', { id: this.activationId, status });
            } catch (error) {
                if (!this.isRetryableHttpError(error) || attempt >= maxRetries) {
                    throw error;
                }
                console.log(`[SMS] ${label}失败: ${error.message}，5秒后重试... (${attempt}/${maxRetries})`);
                await new Promise(r => setTimeout(r, 5000));
            }
        }
        return null;
    }

    parseNumber(value) {
        const num = Number.parseFloat(String(value ?? '').replace(/[^0-9.]+/g, ''));
        return Number.isFinite(num) ? num : null;
    }

    parseInteger(value) {
        const num = Number.parseInt(String(value ?? '').replace(/[^0-9-]+/g, ''), 10);
        return Number.isFinite(num) ? num : null;
    }

    summarizePayload(data) {
        if (Array.isArray(data)) {
            return `array(len=${data.length})`;
        }
        if (!data || typeof data !== 'object') {
            return `${typeof data}: ${String(data).slice(0, 120)}`;
        }
        const keys = Object.keys(data).slice(0, 12).join(',');
        return `object(keys=${keys})`;
    }

    unwrapPriceMatrix(raw) {
        if (!raw || typeof raw !== 'object') return raw;

        const wrapperKeys = ['data', 'result', 'prices', 'countries', 'response'];
        for (const key of wrapperKeys) {
            const value = raw[key];
            if (value && typeof value === 'object') {
                return this.unwrapPriceMatrix(value);
            }
        }

        return raw;
    }

    extractPriceFromNode(node) {
        if (!node || typeof node !== 'object') return null;

        const price = this.parseNumber(
            node.cost ?? node.price ?? node.activationCost ?? node.amount ?? node.rate
        );
        const count = this.parseInteger(
            node.count ?? node.qty ?? node.available ?? node.stock ?? node.total
        );

        if (price === null && count === null) return null;
        return { price, count };
    }

    resolveCountryPriceNode(raw, countryId, service) {
        if (!raw || typeof raw !== 'object') return null;
        const idKey = String(countryId);
        const serviceKey = String(service);

        const candidates = [
            raw[serviceKey]?.[idKey],
            raw[idKey]?.[serviceKey],
            raw[idKey]?.default,
            raw[idKey],
            raw[serviceKey],
        ];

        for (const candidate of candidates) {
            if (candidate && typeof candidate === 'object') {
                return candidate;
            }
        }

        return null;
    }

    extractCountryPrice(raw, countryId, service) {
        const matrix = this.unwrapPriceMatrix(raw);

        if (Array.isArray(matrix)) {
            for (const item of matrix) {
                if (!item || typeof item !== 'object') continue;
                const itemCountryId = this.parseInteger(
                    item.countryId ?? item.country_id ?? item.country ?? item.id
                );
                if (itemCountryId !== Number(countryId)) continue;

                const direct = this.extractPriceFromNode(item);
                if (direct) return direct;

                const serviceNode = item[String(service)] ?? item.serviceData ?? item.data;
                const fromServiceNode = this.extractPriceFromNode(serviceNode);
                if (fromServiceNode) return fromServiceNode;
            }
            return null;
        }

        const node = this.resolveCountryPriceNode(matrix, countryId, service);
        if (!node) return null;
        return this.extractPriceFromNode(node);
    }

    parseCountriesResponse(data) {
        const result = [];
        const pushCountry = (countryId, payload) => {
            if (countryId === null || countryId === undefined) return;
            const heroSmsCountry = this.parseInteger(countryId);
            if (!Number.isFinite(heroSmsCountry)) return;

            if (typeof payload === 'string') {
                result.push({
                    heroSmsCountry,
                    apiName: payload.trim(),
                });
                return;
            }

            if (!payload || typeof payload !== 'object') return;

            const apiName = String(
                payload.name
                ?? payload.country
                ?? payload.title
                ?? payload.eng
                ?? payload.en
                ?? payload.label
                ?? ''
            ).trim();
            const isoCode = String(payload.isoCode ?? payload.iso ?? payload.code ?? payload.iso2 ?? '').trim().toUpperCase();
            const dialCode = String(payload.dialCode ?? payload.phoneCode ?? payload.prefix ?? '').replace(/^\+/, '').trim();

            result.push({
                heroSmsCountry,
                apiName,
                isoCode,
                dialCode,
            });
        };

        if (Array.isArray(data)) {
            for (const item of data) {
                if (item && typeof item === 'object') {
                    pushCountry(item.id ?? item.countryId ?? item.country_id, item);
                }
            }
            return result;
        }

        if (!data || typeof data !== 'object') {
            return result;
        }

        for (const [key, value] of Object.entries(data)) {
            if (/^\d+$/.test(key)) {
                pushCountry(key, value);
                continue;
            }

            if (value && typeof value === 'object') {
                const nestedId = value.id ?? value.countryId ?? value.country_id;
                if (nestedId !== undefined && nestedId !== null) {
                    pushCountry(nestedId, {
                        ...value,
                        name: value.name ?? value.chn ?? value.eng ?? value.rus ?? key,
                        isoCode: value.isoCode ?? value.iso ?? value.code ?? value.iso2 ?? '',
                    });
                }
            }
        }

        if (result.length > 0) return result;

        const nestedLists = Object.values(data).filter(v => Array.isArray(v) || (v && typeof v === 'object'));
        for (const entry of nestedLists) {
            const parsed = this.parseCountriesResponse(entry);
            if (parsed.length > 0) {
                result.push(...parsed);
            }
        }

        return result;
    }

    parseTopCountriesResponse(data) {
        const rows = [];
        const pushRow = (item) => {
            if (!item || typeof item !== 'object') return;
            const heroSmsCountry = this.parseInteger(
                item.country ?? item.countryId ?? item.country_id ?? item.id
            );
            const price = this.parseNumber(
                item.price ?? item.cost ?? item.retail_price ?? item.retailPrice
            );
            const count = this.parseInteger(
                item.count ?? item.qty ?? item.available ?? item.stock ?? item.total
            );
            const apiName = String(
                item.name
                ?? item.countryName
                ?? item.country_name
                ?? item.title
                ?? item.text
                ?? item.label
                ?? item.countryText
                ?? ''
            ).trim();
            const isoCode = String(
                item.isoCode ?? item.iso ?? item.code ?? item.iso2 ?? ''
            ).trim().toUpperCase();
            const dialCode = String(
                item.dialCode ?? item.phoneCode ?? item.prefix ?? item.phone_prefix ?? ''
            ).replace(/^\+/, '').trim();

            if (!Number.isFinite(heroSmsCountry) || price === null) return;
            rows.push({
                heroSmsCountry,
                price,
                count,
                apiName,
                isoCode,
                dialCode,
            });
        };

        if (Array.isArray(data)) {
            for (const item of data) pushRow(item);
            return rows;
        }

        if (!data || typeof data !== 'object') {
            return rows;
        }

        for (const [key, value] of Object.entries(data)) {
            if (/^\d+$/.test(key) && value && typeof value === 'object') {
                pushRow(value);
            }
        }

        if (rows.length > 0) return rows;

        for (const key of ['data', 'result', 'response']) {
            const nested = data[key];
            if (nested && typeof nested === 'object') {
                const parsed = this.parseTopCountriesResponse(nested);
                if (parsed.length > 0) return parsed;
            }
        }

        return rows;
    }

    async getCountries() {
        const actions = ['getCountries', 'getCountriesList'];
        for (const action of actions) {
            try {
                const data = await this.request(action);
                if (typeof data === 'string') {
                    try {
                        const parsed = JSON.parse(data);
                        const countries = this.parseCountriesResponse(parsed);
                        if (countries.length > 0) return countries;
                    } catch (e) {}
                } else {
                    const countries = this.parseCountriesResponse(data);
                    if (countries.length > 0) return countries;
                }
            } catch (error) {}
        }
        return [];
    }

    async getTopCountriesByService(service = 'dr') {
        const actions = ['getTopCountriesByServiceRank', 'getTopCountriesByService'];
        let lastError = null;

        for (const action of actions) {
            try {
                const data = await this.request(action, { service });
                const parsed = this.parseTopCountriesResponse(data);
                if (parsed.length > 0) {
                    return parsed.sort((a, b) => {
                        if (a.price !== b.price) return a.price - b.price;
                        return (b.count || 0) - (a.count || 0);
                    });
                }
                lastError = new Error(`top countries empty: ${this.summarizePayload(data)}`);
            } catch (error) {
                lastError = error;
            }
        }

        throw lastError || new Error('未能获取 Top Countries 列表');
    }

    async getOperators(country) {
        const data = await this.request('getOperators', { country });
        const raw = data?.countryOperators?.[String(country)] || data?.countryOperators?.[Number(country)] || [];
        if (!Array.isArray(raw)) return [];
        return raw
            .map(item => String(item || '').trim())
            .filter(Boolean);
    }

    async getOperatorQuoteOptions(service = 'dr', country) {
        const operators = await this.getOperators(country);
        if (operators.length === 0) return [];

        const options = [];
        for (const operator of operators) {
            try {
                const data = await this.request('getPrices', { service, country, operator });
                const parsed = this.extractCountryPrice(data, country, service);
                options.push({
                    operator,
                    price: parsed?.price ?? null,
                    count: parsed?.count ?? null,
                    source: 'operator',
                });
            } catch (error) {
                options.push({
                    operator,
                    price: null,
                    count: null,
                    source: 'operator',
                    error: error?.message || 'unknown',
                });
            }
        }

        return options;
    }

    async getPriceMatrix(service = 'dr') {
        const actions = ['getPricesVerification', 'getPrices'];
        let lastError = null;

        for (const action of actions) {
            try {
                const data = await this.request(action, { service });
                if (typeof data === 'string') {
                    try {
                        return JSON.parse(data);
                    } catch (error) {
                        lastError = new Error(`价格接口 ${action} 返回了非 JSON: ${data}`);
                        continue;
                    }
                }
                return data;
            } catch (error) {
                lastError = error;
            }
        }

        throw lastError || new Error('未能获取 HeroSMS 价格列表');
    }

    async listCountryPrices(service = 'dr', countries = []) {
        const matrix = await this.getPriceMatrix(service);
        const priced = countries
            .map((country) => {
                const heroSmsCountry = Number(country.heroSmsCountry);
                if (!Number.isFinite(heroSmsCountry)) return null;
                const parsed = this.extractCountryPrice(matrix, heroSmsCountry, service);
                if (!parsed || parsed.price === null) return null;
                return {
                    ...country,
                    price: parsed.price,
                    count: parsed.count,
                };
            })
            .filter(Boolean)
            .sort((a, b) => {
                if (a.price !== b.price) return a.price - b.price;
                return (b.count || 0) - (a.count || 0);
            });

        if (priced.length === 0) {
            console.warn(`[SMS] 价格接口已返回数据，但未解析出任何国家价格。payload=${this.summarizePayload(matrix)}`);
        }

        return priced;
    }

    /**
     * 获取手机号码（V2 接口，返回 JSON）
     * @param {string} service - 服务代码（OpenAI = 'dr'）
     * @param {number} country - 国家 ID（英国 = 16）
     * @returns {Promise<{activationId: number, phoneNumber: string}>}
     */
    async getNumber(service = 'dr', country = 16, maxRetries = 5, operator = '') {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            let data;
            try {
                const params = { service, country };
                if (operator) params.operator = operator;
                data = await this.request('getNumberV2', params);
            } catch (httpErr) {
                console.log(`[SMS] API 请求失败: ${httpErr.message}，${attempt < maxRetries ? '5秒后重试...' : '已达最大重试次数'} (${attempt}/${maxRetries})`);
                if (attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, 5000));
                    continue;
                }
                throw new Error(`HeroSMS API 不可用: ${httpErr.message}`);
            }

            if (typeof data === 'string') {
                if (data === 'NO_BALANCE') throw new Error('HeroSMS 余额不足');
                if (data === 'BAD_KEY') throw new Error('HeroSMS API Key 无效');
                if (data === 'NO_NUMBERS') {
                    console.log(`[SMS] 暂无可用号码，${attempt < maxRetries ? '3秒后重试...' : '已达最大重试次数'} (${attempt}/${maxRetries})`);
                    if (attempt < maxRetries) {
                        await new Promise(r => setTimeout(r, 3000));
                        continue;
                    }
                    throw new Error('当前无可用号码（重试耗尽）');
                }
                throw new Error(`获取号码失败: ${data}`);
            }

            this.activationId = data.activationId;
            this.phoneNumber = String(data.phoneNumber);

            if (!this.phoneNumber.startsWith('+')) {
                this.phoneNumber = `+${this.phoneNumber}`;
            }

            const operatorText = operator ? `, operator: ${operator}` : '';
            console.log(`[SMS] 获取号码: ${this.phoneNumber} (activation: ${this.activationId}, 费用: $${data.activationCost}${operatorText})`);
            return { activationId: this.activationId, phoneNumber: this.phoneNumber };
        }
    }

    /**
     * 标记准备接收短信
     */
    async markReady() {
        await this.setStatusWithRetry(1, '标记准备接收短信');
        console.log('[SMS] 已标记为准备接收短信');
    }

    /**
     * 查询激活状态（V2 接口）
     * @returns {Promise<{received: boolean, code?: string}>}
     */
    async getStatus() {
        const data = await this.request('getStatusV2', { id: this.activationId });

        if (typeof data === 'string') {
            if (data === 'STATUS_WAIT_CODE') return { received: false };
            if (data === 'STATUS_CANCEL') {
                const err = new Error('激活已被取消');
                err.code = 'SMS_ACTIVATION_CANCELLED';
                throw err;
            }
            if (data.startsWith('STATUS_OK:')) {
                return { received: true, code: data.split(':')[1] };
            }
            return { received: false };
        }

        // V2 JSON 响应
        const smsCode = data?.sms?.code;
        if (smsCode && smsCode.length > 0) {
            return { received: true, code: smsCode };
        }
        return { received: false };
    }

    /**
     * 轮询等待短信验证码
     * @param {object} options
     * @param {number} options.interval - 轮询间隔（毫秒，默认 5000）
     * @param {number} options.maxAttempts - 最大尝试次数（默认 60 = 5分钟）
     * @returns {Promise<string>} 验证码
     */
    async pollForCode(options = {}) {
        const { interval = 5000, maxAttempts = 60 } = options;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            console.log(`[SMS] 等待短信验证码... (${attempt}/${maxAttempts})`);

            try {
                const result = await this.getStatus();
                if (result.received) {
                    console.log(`[SMS] 收到验证码: ${result.code}`);
                    return result.code;
                }
            } catch (error) {
                const msg = String(error?.message || '');
                if (error?.code === 'SMS_ACTIVATION_CANCELLED' || msg.includes('激活已被取消')) {
                    console.error('[SMS] 检测到激活已取消，立即结束当前轮');
                    const cancelError = new Error('短信激活已取消，结束当前轮');
                    cancelError.code = 'SMS_ACTIVATION_CANCELLED';
                    cancelError.noRetryDelay = true;
                    throw cancelError;
                }
                console.error(`[SMS] 查询状态出错: ${error.message}`);
            }

            await new Promise(resolve => setTimeout(resolve, interval));
        }

        console.error(`[SMS] 超过 ${(maxAttempts * interval) / 1000} 秒未收到验证码，尝试取消激活...`);
        await this.cancel();
        const timeoutError = new Error(`短信验证码超时（等待 ${(maxAttempts * interval) / 1000} 秒），已取消激活`);
        timeoutError.code = 'SMS_CODE_TIMEOUT_CANCELLED';
        timeoutError.noRetryDelay = true;
        throw timeoutError;
    }

    /**
     * 完成激活（确认已收到验证码）
     */
    async complete() {
        await this.setStatusWithRetry(6, '完成激活');
        console.log('[SMS] 激活已完成');
    }

    /**
     * 取消激活（退款）
     */
    async cancel() {
        try {
            await this.setStatusWithRetry(8, '取消激活');
            console.log('[SMS] 激活已取消（退款）');
        } catch (error) {
            // 409 = EARLY_CANCEL_DENIED（刚创建的号码不能立即取消）
            // 其他错误也不应阻塞主流程
            console.error(`[SMS] 取消失败: ${error.message}（号码将在超时后自动退款）`);
        }
    }

    /**
     * 获取格式化的手机号
     * @returns {string}
     */
    getPhone() {
        return this.phoneNumber;
    }
}

module.exports = { SMSProvider };
