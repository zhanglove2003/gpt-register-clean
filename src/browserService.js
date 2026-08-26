const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { logInputValue } = require('./runLogger');

const SLEEP = (ms) => new Promise(r => setTimeout(r, ms));

class BrowserService {
    constructor(proxy, browserOptions = {}) {
        this.browser = null;
        this.page = null;
        this.proxy = proxy; // { host, port, username, password }
        const executablePath =
            browserOptions.chromePath ||
            browserOptions.edgePath ||
            config.chromePath ||
            config.edgePath ||
            process.env.CHROME_PATH ||
            '';
        this.browserOptions = {
            useChrome: browserOptions.useChrome ?? config.useChrome ?? true,
            chromePath: executablePath,
            userDataDir: browserOptions.userDataDir ?? config.browserUserDataDir ?? '',
            incognito: browserOptions.incognito ?? config.browserIncognito ?? true,
            clearChatGptSession: browserOptions.clearChatGptSession ?? config.browserClearChatGptSession ?? false,
        };
    }

    /**
     * 启动浏览器（puppeteer-real-browser，自动绕过 Turnstile）
     */
    async launch() {
        const connectOptions = {
            headless: false,
            turnstile: true,
            disableXvfb: process.platform === 'linux' && !!process.env.DISPLAY,
            args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN'],
        };
        if (this.browserOptions.incognito) {
            connectOptions.args.push('--incognito');
        }

        if (connectOptions.disableXvfb) {
            console.log(`[Browser] 使用当前图形会话 DISPLAY=${process.env.DISPLAY}，禁用 puppeteer-real-browser 内置 Xvfb`);
        }

        // 使用显式配置的 Chrome/Chromium 可执行文件
        if (this.browserOptions.useChrome && this.browserOptions.chromePath) {
            // puppeteer-real-browser 底层使用 chrome-launcher，需通过 customConfig.chromePath 指定路径
            connectOptions.customConfig = {
                ...(connectOptions.customConfig || {}),
                chromePath: this.browserOptions.chromePath,
            };
            // 兜底：部分 chrome-launcher 版本会读取 CHROME_PATH
            process.env.CHROME_PATH = this.browserOptions.chromePath;
            console.log(`[Browser] 使用浏览器: ${this.browserOptions.chromePath}`);
        }

        if (this.browserOptions.userDataDir) {
            fs.mkdirSync(this.browserOptions.userDataDir, { recursive: true });
            connectOptions.customConfig = {
                ...(connectOptions.customConfig || {}),
                userDataDir: this.browserOptions.userDataDir,
            };
            console.log(`[Browser] 使用用户数据目录: ${this.browserOptions.userDataDir}`);
        }

        if (this.proxy) {
            connectOptions.proxy = {
                host: this.proxy.host,
                port: this.proxy.port,
                username: this.proxy.username,
                password: this.proxy.password,
            };
            console.log(`[Browser] 使用代理: ${this.proxy.host}:${this.proxy.port}`);
        }

        console.log('[Browser] 启动 puppeteer-real-browser...');
        const { page, browser } = await connect(connectOptions);
        this.browser = browser;

        // 尝试在已有窗口打开新标签页
        let targetPage = null;
        const pages = await browser.pages?.();
        if (pages && pages.length > 0) {
            targetPage = await browser.newPage();
            await targetPage.bringToFront();
        } else {
            targetPage = page;
        }
        this.page = targetPage;
        await targetPage.setViewport({ width: 1280, height: 900 });
        await targetPage.setExtraHTTPHeaders({
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        });
        await targetPage.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'language', {
                get: () => 'zh-CN',
            });
            Object.defineProperty(navigator, 'languages', {
                get: () => ['zh-CN', 'zh', 'en-US', 'en'],
            });
        });
        console.log('[Browser] 浏览器已启动 (1280x900)');
    }

    /**
     * 关闭浏览器
     */
    async close() {
        if (this.browser) {
            await this.browser.close().catch(() => {});
            this.browser = null;
            this.page = null;
        }
    }

    /**
     * 等待 Cloudflare 验证通过
     */
    async waitForCloudflare(timeout = 60000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            try {
                const title = await this.page.title();
                if (!title.includes('moment') && !title.includes('稍候') && !title.includes('Checking')) {
                    console.log('[Browser] Cloudflare 验证通过');
                    return;
                }
            } catch (e) {
                // 页面导航时 context 可能被销毁，等一下再试
            }
            await SLEEP(3000);
        }
        throw new Error('Cloudflare 验证超时');
    }

    /**
     * 通过文字匹配点击按钮。
     */
    async clickButtonByText(text, timeout = 10000) {
        const candidates = Array.isArray(text) ? text : [text];
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const handle = await this.page.evaluateHandle((texts) => {
                const elements = Array.from(document.querySelectorAll('button, [role="button"], a'));
                return elements.find((el) => {
                    const innerText = el.innerText || el.textContent || '';
                    const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
                    return !disabled && texts.some(t => innerText.includes(t));
                }) || null;
            }, candidates).catch(() => null);

            const element = handle?.asElement?.();
            if (element) {
                try {
                    await element.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }));
                    await SLEEP(250);
                    await element.click({ delay: 80 });
                    await handle.dispose().catch(() => {});
                    return;
                } catch (error) {
                    await this.page.evaluate((el) => {
                        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
                            el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
                        });
                    }, element).catch(() => {});
                    await handle.dispose().catch(() => {});
                    return;
                }
            }

            await handle?.dispose?.().catch(() => {});
            await SLEEP(1000);
        }
        throw new Error(`找不到包含"${candidates.join('" / "')}"的按钮`);
    }

    /**
     * 等待选择器出现
     */
    async waitFor(selector, timeout = 30000) {
        await this.page.waitForSelector(selector, { timeout });
    }

    /**
     * 等待页面上出现指定文字
     */
    async waitForTextOnPage(text, timeout = 30000) {
        const candidates = Array.isArray(text) ? text : [text];
        const start = Date.now();
        while (Date.now() - start < timeout) {
            try {
                const found = await this.page.evaluate((texts) => {
                    const bodyText = document.body?.innerText || '';
                    return texts.some(t => bodyText.includes(t));
                }, candidates);
                if (found) return;
            } catch (e) { /* context destroyed during navigation */ }
            await SLEEP(1000);
        }
        throw new Error(`等待文字"${candidates.join('" / "')}"超时`);
    }

    /**
     * 等待包含指定文字的按钮出现
     */
    async waitForButtonByText(text, timeout = 30000) {
        const candidates = Array.isArray(text) ? text : [text];
        const start = Date.now();
        while (Date.now() - start < timeout) {
            try {
                const found = await this.page.evaluate((texts) => {
                    for (const b of document.querySelectorAll('button, [role="button"], a')) {
                        const innerText = b.innerText || '';
                        if (texts.some(t => innerText.includes(t))) return true;
                    }
                    return false;
                }, candidates);
                if (found) return;
            } catch (e) { /* context destroyed during navigation */ }
            await SLEEP(2000);
        }
        throw new Error(`等待按钮"${candidates.join('" / "')}"超时`);
    }

    /**
     * 截图（调试用）
     */
    async screenshot(filename) {
        const screenshotDir = path.resolve(process.cwd(), 'debug-screenshots');
        fs.mkdirSync(screenshotDir, { recursive: true });
        // 只接受不含路径分隔符的简单文件名，避免把任意输入拼进文件路径
        const basename = path.basename(String(filename || '')).replace(/[\\/:*?"<>|]/g, '_');
        const screenshotPath = path.join(screenshotDir, basename);
        await this.page.screenshot({ path: screenshotPath });
        console.log(`[Browser] 截图: ${screenshotPath}`);
    }

    async clearChatGptSession() {
        const authCookieDomains = [
            'chatgpt.com',
            '.chatgpt.com',
            'chat.openai.com',
            '.chat.openai.com',
            'auth.openai.com',
            '.auth.openai.com',
            'openai.com',
            '.openai.com',
        ];
        const storageOrigins = [
            'https://chatgpt.com',
            'https://chat.openai.com',
            'https://auth.openai.com',
            'https://openai.com',
        ];
        const preserveCookieNames = new Set([
            'cf_clearance',
            '__cf_bm',
            '_cfuvid',
        ]);

        try {
            const client = await this.page.target().createCDPSession();
            const allCookies = (await client.send('Network.getAllCookies')).cookies || [];
            const authCookies = allCookies.filter((cookie) => (
                authCookieDomains.includes(cookie.domain)
                && !preserveCookieNames.has(cookie.name)
                && !cookie.name.toLowerCase().startsWith('cf_')
                && !cookie.name.toLowerCase().startsWith('__cf')
            ));

            for (const cookie of authCookies) {
                await client.send('Network.deleteCookies', {
                    name: cookie.name,
                    domain: cookie.domain,
                    path: cookie.path || '/',
                }).catch(() => {});
            }

            const storageTypes = 'appcache,cache_storage,indexeddb,local_storage,service_workers,websql';
            for (const origin of storageOrigins) {
                await client.send('Storage.clearDataForOrigin', {
                    origin,
                    storageTypes,
                }).catch(() => {});
            }

            await client.detach().catch(() => {});
            console.log(`[Browser] 已清理 ChatGPT/OpenAI 登录态 cookie ${authCookies.length} 个`);
        } catch (error) {
            console.warn(`[Browser] 清理 ChatGPT/OpenAI 登录态失败: ${error.message}`);
        }
    }

    logInput(field, value, context = '') {
        logInputValue(field, value, context);
    }

    async fillPasswordElement(input, password, logField, logTag) {
        await input.click({ clickCount: 3 }).catch(() => {});
        await SLEEP(150);

        try {
            const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
            await this.page.keyboard.down(mod);
            await this.page.keyboard.press('A');
            await this.page.keyboard.up(mod);
            await SLEEP(100);
        } catch (e) {}

        await this.page.keyboard.press('Backspace').catch(() => {});
        await this.page.keyboard.press('Delete').catch(() => {});

        await this.page.evaluate((el) => {
            if (!el) return;
            el.focus();
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            setter?.call(el, '');
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }, input).catch(() => {});

        this.logInput(logField, password, logTag);
        await input.type(password, { delay: 30 });

        await this.page.evaluate((el, expected) => {
            if (!el) return false;
            return el.value === expected;
        }, input, password).catch(() => false);

        await SLEEP(300);
        return input;
    }

    async fillPasswordInput(selector, password, logField, logTag) {
        const input = await this.page.$(selector);
        if (!input) {
            throw new Error(`未找到密码输入框: ${selector}`);
        }
        return this.fillPasswordElement(input, password, logField, logTag);
    }

    async detectCredentialError(tag = '[OAuth]') {
        const result = await this.page.evaluate(() => {
            const text = document.body?.innerText || '';
            const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
            const patterns = [
                /incorrect phone number or password/i,
                /incorrect email or password/i,
                /wrong password/i,
                /手机号或密码错误/i,
                /邮箱或密码错误/i,
                /密码错误/i,
            ];
            const matched = lines.find(line => patterns.some(pattern => pattern.test(line)));
            return matched || '';
        }).catch(() => '');

        if (result) {
            console.error(`${tag} 检测到登录失败文案: ${result}`);
            await this.screenshot('oauth-password-error.png').catch(() => {});
            const err = new Error(`登录失败: ${result}`);
            err.code = 'OAUTH_INVALID_CREDENTIALS';
            err.noRetryDelay = true;
            throw err;
        }
    }

    normalizeComparableText(value = '') {
        return String(value || '').trim().toLowerCase();
    }

    normalizePhoneDigits(value = '') {
        return String(value || '').replace(/\D+/g, '');
    }

    async chooseExistingOAuthAccount({ phone = '', fullName = '', tag = '[OAuth]' } = {}) {
        const phoneDigits = this.normalizePhoneDigits(phone);
        const localDigits = phoneDigits.length > 6 ? phoneDigits.slice(-9) : phoneDigits;
        const nameText = this.normalizeComparableText(fullName);

        const result = await this.page.evaluate(({ phoneDigits, localDigits, nameText }) => {
            const isVisible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0
                    && rect.height > 0
                    && style.visibility !== 'hidden'
                    && style.display !== 'none';
            };

            const digitsOnly = (text) => String(text || '').replace(/\D+/g, '');
            const normalized = (text) => String(text || '').trim().toLowerCase();
            const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, [tabindex]'));
            let best = null;

            for (const node of nodes) {
                if (!isVisible(node)) continue;
                const text = (node.innerText || node.textContent || '').trim();
                if (!text) continue;
                const textNorm = normalized(text);
                const digits = digitsOnly(text);

                let score = 0;
                if (phoneDigits && digits.includes(phoneDigits)) score += 100;
                if (localDigits && digits.includes(localDigits)) score += 80;
                if (nameText && textNorm.includes(nameText)) score += 60;
                if (textNorm.includes('choose account') || textNorm.includes('选择帐户') || textNorm.includes('选择账户')) score -= 10;
                if (text.length < 4) score -= 30;

                if (score <= 0) continue;

                if (!best || score > best.score) {
                    best = {
                        score,
                        text: text.slice(0, 200),
                        rect: node.getBoundingClientRect().toJSON ? node.getBoundingClientRect().toJSON() : null,
                        x: node.getBoundingClientRect().left + node.getBoundingClientRect().width / 2,
                        y: node.getBoundingClientRect().top + node.getBoundingClientRect().height / 2,
                    };
                }
            }

            if (!best && nodes.length === 1) {
                const node = nodes[0];
                const text = (node.innerText || node.textContent || '').trim();
                if (isVisible(node) && text) {
                    best = {
                        score: 1,
                        text: text.slice(0, 200),
                        x: node.getBoundingClientRect().left + node.getBoundingClientRect().width / 2,
                        y: node.getBoundingClientRect().top + node.getBoundingClientRect().height / 2,
                    };
                }
            }

            return best;
        }, { phoneDigits, localDigits, nameText });

        if (!result) {
            throw new Error('choose-an-account 页面未找到可点击的账号卡片');
        }

        console.log(`${tag} 选择已有账号: ${result.text}`);
        await this.page.mouse.click(result.x, result.y);
        await SLEEP(4000);
        await this.waitForCloudflare(30000);
        await SLEEP(2500);
    }

    getPhoneCountry(country = {}) {
        const hasHeroSmsCountry = country.heroSmsCountry !== undefined
            && country.heroSmsCountry !== null
            && String(country.heroSmsCountry).trim() !== '';
        return {
            isoCode: String(country.isoCode || '').trim().toUpperCase(),
            dialCode: String(country.dialCode || '').replace(/^\+/, '').trim(),
            name: String(country.name || country.countryHint || '').trim(),
            heroSmsCountry: hasHeroSmsCountry && Number.isFinite(Number(country.heroSmsCountry))
                ? Number(country.heroSmsCountry)
                : null,
        };
    }

    getLocalPhoneNumber(phone, country = {}) {
        const normalizedPhone = String(phone || '').trim();
        const { dialCode } = this.getPhoneCountry(country);
        if (!normalizedPhone) return '';
        if (dialCode && normalizedPhone.startsWith(`+${dialCode}`)) {
            return normalizedPhone.slice(dialCode.length + 1);
        }
        return normalizedPhone.replace(/^\+/, '');
    }

    findPhoneConflictDetails(pageState = {}) {
        const url = String(pageState.url || '');
        const text = String(pageState.text || '');
        const lines = text
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean);

        const patterns = [
            /手机号.{0,20}(已被绑定|已绑定|已注册|已被注册|已存在|已使用)/i,
            /该手机.{0,20}(已被绑定|已绑定|已注册|已存在)/i,
            /号码.{0,20}(已被绑定|已绑定|已注册|已存在|已使用)/i,
            /phone number.{0,40}(already (?:exists|registered|used|linked|associated|in use))/i,
            /mobile number.{0,40}(already (?:exists|registered|used|linked|associated|in use))/i,
            /this number.{0,40}(already (?:exists|registered|used|linked|associated|in use))/i,
            /already have an account/i,
            /account already exists/i,
        ];

        for (const line of lines) {
            if (patterns.some(pattern => pattern.test(line))) {
                return {
                    matchedText: line.slice(0, 200),
                    url,
                };
            }
        }

        return null;
    }

    async throwPhoneConflictError(details, stage = '[Phone]') {
        const matchedText = String(details?.matchedText || '').trim();
        let currentUrl = String(details?.url || '');
        if (!currentUrl) {
            try {
                currentUrl = String(this.page?.url?.() || '');
            } catch (e) {
                currentUrl = '';
            }
        }
        console.error(`${stage} 检测到手机号已被占用或已绑定，结束当前轮重试`);
        console.error(`${stage} 页面: ${currentUrl}`);
        if (matchedText) {
            console.error(`${stage} 命中文案: ${matchedText}`);
        }
        await this.screenshot('phone-conflict.png').catch(() => {});
        const err = new Error(`当前手机号已存在账号或已被绑定: ${matchedText || currentUrl || 'unknown'}`);
        err.code = 'PHONE_ALREADY_REGISTERED';
        err.noRetryDelay = true;
        throw err;
    }

    async assertNoPhoneConflict(stage = '[Phone]') {
        const pageState = await this.page.evaluate(() => ({
            text: (document.body?.innerText || '').slice(0, 4000),
            url: location.href,
        }));
        const conflict = this.findPhoneConflictDetails(pageState);
        if (conflict) {
            await this.throwPhoneConflictError(conflict, stage);
        }
    }

    /**
     * 勾选当前页面上可见的未选中 checkbox（兼容原生 checkbox 和 aria checkbox）
     */
    async checkVisibleCheckboxes(tag = '[Checkbox]') {
        const checkedCount = await this.page.evaluate(() => {
            const isVisible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0
                    && rect.height > 0
                    && style.visibility !== 'hidden'
                    && style.display !== 'none';
            };

            let count = 0;

            for (const input of document.querySelectorAll('input[type="checkbox"]')) {
                if (input.disabled || input.checked || !isVisible(input)) continue;

                const target =
                    input.closest('label') ||
                    (input.id ? document.querySelector(`label[for="${input.id}"]`) : null) ||
                    input;

                ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
                    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
                });

                if (!input.checked) {
                    input.checked = true;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }
                count++;
            }

            for (const box of document.querySelectorAll('[role="checkbox"]')) {
                if (!isVisible(box)) continue;
                const checked = String(box.getAttribute('aria-checked') || '').toLowerCase();
                if (checked === 'true') continue;

                ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
                    box.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
                });
                count++;
            }

            return count;
        });

        if (checkedCount > 0) {
            console.log(`${tag} 已勾选 checkbox: ${checkedCount}`);
            await SLEEP(800);
        }
    }

    /**
     * 填写 about-you 页面（全名 + 年龄/生日）并提交
     * 适配新版（name + age 数字输入）和旧版（name + spinbutton 日期选择器）
     * @param {string} fullName - 全名
     * @param {number|string} age - 年龄
     * @param {string} birthDate - 生日 YYYY-MM-DD（旧版 spinbutton 兜底用）
     * @param {string} tag - 日志标签
     */
    async fillAboutYouAndSubmit(fullName, age, birthDate, tag = '[AboutYou]') {
        await SLEEP(2000);

        // 填写全名
        const nameInput = await this.page.$('input[name="name"]');
        if (nameInput) {
            await nameInput.click({ clickCount: 3 });
            this.logInput('about_you.full_name', fullName, tag);
            await this.page.keyboard.type(fullName, { delay: 30 });
            console.log(`${tag} 已填写全名: ${fullName}`);
        }

        // 优先：新版 age 数字输入框
        const ageInput = await this.page.$('input[name="age"]');
        if (ageInput) {
            // 先清空，再用 Puppeteer ElementHandle.type 输入（触发完整键盘事件链）
            await ageInput.click({ clickCount: 3 });
            await ageInput.press('Backspace');
            this.logInput('about_you.age', String(age), tag);
            await ageInput.type(String(age), { delay: 50 });
            // 再用 nativeSetter 确保 React state 同步
            await this.page.evaluate((ageVal) => {
                const inp = document.querySelector('input[name="age"]');
                if (!inp) return;
                const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                nativeSetter.call(inp, ageVal);
                inp.dispatchEvent(new Event('input', { bubbles: true }));
                inp.dispatchEvent(new Event('change', { bubbles: true }));
            }, String(age));
            console.log(`${tag} 已填写年龄: ${age}`);
        } else {
            // 兜底：旧版 spinbutton 日期选择器
            const parts = (birthDate || '1990-05-15').split('-');
            const spinbuttons = await this.page.$$('[role="spinbutton"]');
            const sbValues = [];
            for (const sb of spinbuttons) {
                const label = await sb.evaluate(el => el.getAttribute('aria-label') || '');
                if (label.includes('年') || label.includes('year')) sbValues.push({ sb, val: parts[0], label: '年' });
                else if (label.includes('月') || label.includes('month')) sbValues.push({ sb, val: parts[1], label: '月' });
                else if (label.includes('日') || label.includes('day')) sbValues.push({ sb, val: parts[2], label: '日' });
            }
            if (sbValues.length > 0) {
                for (const { sb, val, label } of sbValues) {
                    await sb.click();
                    await SLEEP(300);
                    this.logInput(`about_you.birth_${label}`, val, tag);
                    await this.page.keyboard.type(val, { delay: 80 });
                    console.log(`${tag}   ${label}: 输入 ${val}`);
                    await SLEEP(300);
                }
            } else {
                console.log(`${tag} 未找到年龄或生日输入框`);
            }
        }

        // 失焦
        await this.page.click('body');
        await SLEEP(1000);

        // 某些 about-you 页面需要先勾选同意类 checkbox，按钮才会变为可点
        await this.checkVisibleCheckboxes(tag);

        // 原生鼠标点击提交按钮
        const btnPos = await this.page.evaluate(() => {
            for (const b of document.querySelectorAll('button[type="submit"], button')) {
                const text = b.innerText.trim();
                if (text === '继续' || text === 'Continue' || text.includes('完成')) {
                    const rect = b.getBoundingClientRect();
                    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text };
                }
            }
            return null;
        });
        if (btnPos) {
            console.log(`${tag} 点击「${btnPos.text}」...`);
            await this.page.mouse.click(btnPos.x, btnPos.y);
        } else {
            await this.clickSubmitButton();
        }

        await SLEEP(5000);
        await this.waitForCloudflare(60000);
        await SLEEP(3000);
    }

    // ================================================================
    // Phase 1: ChatGPT 注册
    // ================================================================

    /**
     * 导航到注册页面：chatgpt.com → 过 CF → 等页面渲染 → 点免费注册 → 点手机登录
     */
    async navigateToSignup() {
        if (this.browserOptions.clearChatGptSession) {
            await this.clearChatGptSession();
        }

        console.log('[Browser] 导航到 chatgpt.com...');
        await this.page.goto('https://chatgpt.com', {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });

        await this.waitForCloudflare();

        // 等待页面完全渲染（兼容中英文首页文案）
        console.log('[Browser] 等待页面渲染...');
        await this.waitForButtonByText(['免费注册', 'Sign up for free', 'Sign up'], 30000);
        // 额外等待确保 React 事件处理器已绑定
        await SLEEP(5000);

        const signupTexts = ['免费注册', 'Sign up for free', 'Sign up'];
        const modalTexts = ['登录或注册', 'Log in or sign up'];
        let modalReady = false;

        for (let attempt = 1; attempt <= 3; attempt += 1) {
            console.log(`[Browser] 点击「免费注册」... (${attempt}/3)`);
            await this.clickButtonByText(signupTexts, 12000);

            // 等待弹窗出现（兼容中英文弹窗文案）
            console.log('[Browser] 等待注册弹窗...');
            try {
                await this.waitForTextOnPage(modalTexts, 30000);
                modalReady = true;
                break;
            } catch (error) {
                console.warn(`[Browser] 注册弹窗未出现，第 ${attempt} 次等待超时`);
                await SLEEP(2500);
            }
        }

        if (!modalReady) {
            throw new Error('等待注册弹窗超时：点击「免费注册」后未出现登录/注册弹窗');
        }
        await SLEEP(1000);

        console.log('[Browser] 点击「继续使用手机登录」...');
        await this.clickButtonByText([
            '使用电话号码继续',
            '继续使用手机登录',
            '手机登录',
            'Continue with phone number',
            'Continue with phone',
        ], 10000);

        // 等待手机号输入框出现
        console.log('[Browser] 等待手机号输入框...');
        await this.waitFor('input[name="phoneNumberInput"]', 15000);
        console.log('[Browser] 手机号输入页面已就绪');
    }

    /**
     * 选择国家代码（英国 = 44）
     *
     * 支持两种选择器:
     * 1. chatgpt.com 注册弹窗: 标准 <select> 元素
     * 2. auth.openai.com 登录页: React Aria Select 组件（按钮 + 虚拟化 listbox）
     *    - 底层有隐藏 <select>（value 为国家ISO代码如 "GB"）
     *    - 打开后显示虚拟化列表（只渲染可见项），data-key="GB" 标识选项
     *
     * @param {string} dialCode - 国家拨号代码（如 '44'）
     * @param {string} countryHint - 国家名称提示（如 '英国'）
     * @param {string} countryIso - 国家 ISO 代码（如 'GB'），用于 React Aria Select
     */
    async selectCountry(dialCode, countryHint = '', countryIso = '') {
        console.log(`[Browser] 选择国家代码 +${dialCode}...`);

        // 检查是否已经显示了正确的国家（按钮式或 select 式）
        const alreadyCorrect = await this.page.evaluate((code) => {
            // 检查按钮
            for (const b of document.querySelectorAll('button')) {
                const text = b.innerText.trim();
                if (text.includes(`+${code}`) || text.includes(`(${code})`)) {
                    return text;
                }
            }
            // 检查 select
            const select = document.querySelector('select');
            if (select) {
                const selectedOpt = select.options[select.selectedIndex];
                if (selectedOpt && (selectedOpt.text.includes(`(${code})`) || selectedOpt.text.includes(`+${code}`))) {
                    return selectedOpt.text;
                }
            }
            return null;
        }, dialCode);

        if (alreadyCorrect) {
            console.log(`[Browser] 国家已是: ${alreadyCorrect}`);
            return;
        }

        // 检测页面类型：React Aria Select（按钮 + 隐藏 select）vs 标准 select
        const pageType = await this.page.evaluate(() => {
            const hasCountryButton = Array.from(document.querySelectorAll('button')).some(
                b => b.getAttribute('aria-haspopup') === 'listbox' && /\+\d/.test(b.innerText)
            );
            const hasSelect = !!document.querySelector('select');
            if (hasCountryButton) return 'react-aria';  // auth.openai.com 登录页
            if (hasSelect) return 'native-select';       // chatgpt.com 注册弹窗
            return 'unknown';
        });

        console.log(`[Browser] 国家选择器类型: ${pageType}`);

        // ===== React Aria Select（auth.openai.com 登录页）=====
        if (pageType === 'react-aria') {
            // 方法 A（最可靠）: 操作底层隐藏 <select>，利用 React 的 change 事件监听
            // React Aria 的 Select 组件在底层维护一个隐藏的 <select>，
            // 通过 nativeInputValueSetter 设置值并触发 change 事件可以正确更新组件状态
            const isoCode = countryIso || await this.page.evaluate((code, hint) => {
                const select = document.querySelector('select');
                if (!select) return '';
                for (const opt of Array.from(select.options)) {
                    if (hint && opt.text.includes(hint)) return opt.value;
                    if (opt.text.includes(`(${code})`) || opt.text.includes(`+${code}`)) return opt.value;
                }
                return '';
            }, dialCode, countryHint);

            if (isoCode) {
                const result = await this.page.evaluate((iso) => {
                    const select = document.querySelector('select');
                    if (!select) return null;
                    // 用原生 setter 设置值，确保 React 能检测到变化
                    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
                    nativeSetter.call(select, iso);
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                    // 验证按钮是否更新
                    for (const b of document.querySelectorAll('button')) {
                        if (b.getAttribute('aria-haspopup') === 'listbox') return b.innerText.trim();
                    }
                    return 'changed';
                }, isoCode);

                if (result && result.includes(`+${dialCode}`)) {
                    console.log(`[Browser] 已选择 (React Aria hidden select): ${result}`);
                    await SLEEP(500);
                    return;
                }
            }

            // 方法 B（备用）: 打开下拉，滚动虚拟化列表到目标位置，真实鼠标点击
            // 虚拟化列表每项 40px，需先确定目标 index 再滚动
            console.log(`[Browser] 方法 A 未成功，尝试方法 B: 打开下拉 + 滚动点击...`);

            // 找到并点击国家按钮
            const btnBox = await this.page.evaluate(() => {
                for (const b of document.querySelectorAll('button')) {
                    if (b.getAttribute('aria-haspopup') === 'listbox' && /\+\d/.test(b.innerText)) {
                        const rect = b.getBoundingClientRect();
                        return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
                    }
                }
                return null;
            });

            if (btnBox) {
                await this.page.mouse.click(btnBox.x + btnBox.w / 2, btnBox.y + btnBox.h / 2);
                await SLEEP(2000);

                // 确定目标选项的 index（从隐藏 select 中获取）
                const targetIndex = await this.page.evaluate((code, hint) => {
                    const select = document.querySelector('select');
                    if (!select) return -1;
                    const options = Array.from(select.options);
                    for (let i = 0; i < options.length; i++) {
                        if (hint && options[i].text.includes(hint)) return i;
                        if (options[i].text.includes(`(${code})`) || options[i].text.includes(`+${code}`)) return i;
                    }
                    return -1;
                }, dialCode, countryHint);

                if (targetIndex >= 0) {
                    // 滚动虚拟化列表到目标位置（每项 40px）
                    await this.page.evaluate((idx) => {
                        const listbox = document.querySelector('[role="listbox"]');
                        if (!listbox) return;
                        let scroller = listbox;
                        while (scroller && scroller !== document.body) {
                            const style = getComputedStyle(scroller);
                            if (style.overflow === 'auto' || style.overflow === 'scroll' ||
                                style.overflowY === 'auto' || style.overflowY === 'scroll') break;
                            scroller = scroller.parentElement;
                        }
                        if (scroller) scroller.scrollTop = idx * 40;
                    }, targetIndex);
                    await SLEEP(1000);

                    // 查找目标国家的 ISO 代码对应的 option 元素
                    const targetIso = isoCode || await this.page.evaluate((code, hint) => {
                        const select = document.querySelector('select');
                        if (!select) return '';
                        for (const opt of Array.from(select.options)) {
                            if (hint && opt.text.includes(hint)) return opt.value;
                        }
                        return '';
                    }, dialCode, countryHint);

                    // 用真实鼠标点击目标 option
                    const optBox = await this.page.evaluate((iso) => {
                        const option = document.querySelector(`[data-key="${iso}"]`);
                        if (option && option.offsetParent !== null) {
                            const rect = option.getBoundingClientRect();
                            return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
                        }
                        return null;
                    }, targetIso);

                    if (optBox) {
                        await this.page.mouse.click(optBox.x + optBox.w / 2, optBox.y + optBox.h / 2);
                        await SLEEP(1000);
                        console.log(`[Browser] 已选择 (React Aria 滚动点击) +${dialCode}`);
                        return;
                    }
                }

                // 如果滚动点击也失败，关闭下拉
                await this.page.keyboard.press('Escape');
                await SLEEP(500);
            }

            console.log(`[Browser] React Aria 选择器: 所有方法均失败`);
            return;
        }

        // ===== 标准 <select> 元素（chatgpt.com 注册弹窗）=====
        if (pageType === 'native-select') {
            const selectResult = await this.page.evaluate((code, hint) => {
                const select = document.querySelector('select');
                if (!select) return null;
                const options = Array.from(select.options);
                // 优先按国家名称 + 代码匹配
                if (hint) {
                    for (const opt of options) {
                        if (opt.text.includes(hint) && opt.text.includes(`(${code})`)) {
                            select.value = opt.value;
                            select.dispatchEvent(new Event('change', { bubbles: true }));
                            return opt.text;
                        }
                    }
                }
                // 按代码匹配
                for (const opt of options) {
                    if (opt.text.includes(`+(${code})`) || opt.text.includes(`+${code}`)) {
                        select.value = opt.value;
                        select.dispatchEvent(new Event('change', { bubbles: true }));
                        return opt.text;
                    }
                }
                return null;
            }, dialCode, countryHint);

            if (selectResult) {
                console.log(`[Browser] 已选择 (标准 select): ${selectResult}`);
                await SLEEP(1000);
                return;
            }
        }

        console.log(`[Browser] 未找到国家选择器，跳过`);
    }

    /**
     * 输入手机号并点击继续
     * @param {string} localNumber - 不含国家代码的本地号码
     */
    async enterPhone(localNumber) {
        console.log(`[Browser] 输入手机号: ${localNumber}`);
        const input = await this.page.$('input[name="phoneNumberInput"]');
        await input.click({ clickCount: 3 }); // 全选已有内容
        this.logInput('phone.local_number', localNumber, '[Phone]');
        await input.type(localNumber, { delay: 50 });
        await SLEEP(500);

        // 点击手机号表单的提交按钮（精确匹配，避免误点「继续使用 Google 登录」）
        console.log('[Browser] 点击提交按钮...');
        await this.page.evaluate(() => {
            // 优先找 type=submit 且文字恰好是"继续"的按钮
            for (const b of document.querySelectorAll('button[type="submit"]')) {
                const text = b.innerText.trim();
                if (text === '继续' || text === 'Continue') {
                    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
                        b.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
                    });
                    return;
                }
            }
        });
        await SLEEP(3000);

        // 提交手机号后可能跳转到 auth.openai.com 并触发新一轮 Cloudflare
        console.log('[Browser] 检查是否需要再次通过 Cloudflare...');
        await this.waitForCloudflare(60000);
        await SLEEP(5000);
        await this.assertNoPhoneConflict('[PhoneSubmit]');

        await this.screenshot('after-phone-submit.png');
        console.log('[Browser] 已提交手机号（截图已保存到 debug-screenshots/after-phone-submit.png）');
    }

    /**
     * 检测提交手机号后的页面状态
     * @returns {'sms'|'password'|'unknown'} - sms=需要验证码, password=直接创建密码
     */
    async detectPageAfterPhone() {
        console.log('[Browser] 检测页面状态...');
        for (let i = 0; i < 10; i++) {
            try {
                const state = await this.page.evaluate(() => {
                    const text = document.body?.innerText || '';
                    if (text.includes('创建密码') || text.includes('Create password') || text.includes('密码'))
                        return 'password';
                    if (text.includes('验证码') || text.includes('code') || text.includes('verification'))
                        return 'sms';
                    return 'loading';
                });
                if (state !== 'loading') {
                    console.log(`[Browser] 页面状态: ${state}`);
                    return state;
                }
            } catch (e) { /* context destroyed */ }
            await SLEEP(2000);
        }
        console.log('[Browser] 页面状态不确定，默认为 password');
        return 'password';
    }

    /**
     * 输入短信验证码
     * @param {string} code - 6位验证码
     */
    async enterSmsCode(code) {
        console.log(`[Browser] 输入验证码: ${code}`);
        await SLEEP(2000);

        // 用 Puppeteer 原生方法找到输入框并点击聚焦
        const inputs = await this.page.$$('input:not([type="hidden"]):not([type="password"])');
        let targetInput = null;
        for (const inp of inputs) {
            const info = await inp.evaluate(el => ({
                name: el.name, visible: el.offsetParent !== null, type: el.type,
            }));
            if (info.visible && info.name !== 'phoneNumberInput') {
                targetInput = inp;
                break;
            }
        }

        if (targetInput) {
            // 用 Puppeteer 原生 click 聚焦，再用 type 输入（确保键盘事件发到正确元素）
            await targetInput.click({ clickCount: 3 });
            await SLEEP(300);
            this.logInput('sms.code', code, '[SMS]');
            await targetInput.type(code, { delay: 80 });
            console.log('[Browser] 验证码已输入');
        } else {
            // 兜底：直接键盘输入
            console.log('[Browser] 未找到输入框，尝试 Tab + 键盘输入...');
            await this.page.keyboard.press('Tab');
            await SLEEP(300);
            this.logInput('sms.code', code, '[SMS]');
            await this.page.keyboard.type(code, { delay: 80 });
        }

        await SLEEP(1000);

        // 点击提交
        await this.clickSubmitButton();
        await SLEEP(3000);
    }

    /**
     * 完成注册资料填写（密码、姓名、生日、验证码等）
     * @param {object} userData - 用户数据
     * @param {function} onSmsNeeded - 当需要 SMS 验证码时的回调，应返回验证码字符串
     */
    async completeProfile(userData, onSmsNeeded) {
        console.log('[Browser] 开始填写注册资料...');
        let lastHandledUrl = '';

        for (let round = 0; round < 20; round++) {
            await SLEEP(3000);

            let pageState;
            try {
                pageState = await this.page.evaluate(() => {
                    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"])'));
                    return {
                        inputs: inputs.map(i => ({ type: i.type, name: i.name, placeholder: i.placeholder, id: i.id })),
                        text: (document.body.innerText || '').substring(0, 800),
                        url: location.href,
                    };
                });
            } catch (e) {
                console.log(`[Browser] Round ${round}: 页面上下文变化，等待...`);
                lastHandledUrl = '';
                continue;
            }

            const url = pageState.url;
            const isPasswordPage = url.includes('password') || pageState.inputs.some(i => i.type === 'password');
            const text = String(pageState.text || '');
            const phoneConflict = this.findPhoneConflictDetails(pageState);

            if (phoneConflict) {
                await this.throwPhoneConflictError(phoneConflict, '[Phase1]');
            }

            const accountCreateFailed =
                url.includes('/auth/error') ||
                /创建帐户失败|创建账户失败|failed to create account|couldn'?t create/i.test(text);
            if (accountCreateFailed) {
                await this.screenshot('account-create-failed.png').catch(() => {});
                const err = new Error(`创建账号失败，页面停在: ${url}`);
                err.code = 'ACCOUNT_CREATE_FAILED';
                err.shouldCancelActivation = true;
                throw err;
            }

            // 如果页面没变化，跳过（防止重复操作）
            if (url === lastHandledUrl && !isPasswordPage) {
                console.log(`[Browser] Round ${round}: 页面未变化，等待...`);
                continue;
            }

            console.log(`[Browser] Round ${round}: ${url.substring(0, 70)}, inputs=${pageState.inputs.length}`);

            // 完成：到达 ChatGPT 主页 或 about-you 后续页面
            if (url.includes('chatgpt.com') && !url.includes('auth.openai.com')) {
                console.log('[Browser] 注册完成，已到达 ChatGPT！');
                return true;
            }

            // about-you 页面：全名 + 年龄/生日
            
            if (url.includes('about-you') || url.includes('about_you')) {
                console.log('[Browser] 到达 about-you 页面...');
                await this.fillAboutYouAndSubmit(userData.fullName, userData.age, userData.birthDate, '[Phase1]');
                await this.screenshot('about-you-filled.png');
                lastHandledUrl = url;
                continue;
            }

            // 密码页
            if (isPasswordPage) {
                const isLoginPasswordPage =
                    url.includes('/log-in/password') ||
                    text.includes('忘记密码') ||
                    text.toLowerCase().includes('forgot password');

                if (isLoginPasswordPage) {
                    const err = new Error('当前手机号已存在账号，落到了登录密码页');
                    err.code = 'PHONE_ALREADY_REGISTERED';
                    err.noRetryDelay = true;
                    throw err;
                }

                console.log('[Browser] 填写密码...');
                const pwdInputs = await this.page.$$('input[type="password"]');
                if (pwdInputs.length === 0) {
                    throw new Error('密码页未找到 password 输入框');
                }
                for (let index = 0; index < pwdInputs.length; index += 1) {
                    await this.fillPasswordElement(
                        pwdInputs[index],
                        userData.password,
                        index === 0 ? 'register.password' : `register.password.${index + 1}`,
                        '[Phase1]'
                    );
                }
                await SLEEP(500);
                await this.page.keyboard.press('Enter').catch(() => {});
                await SLEEP(1000);
                await this.clickSubmitButton();
                lastHandledUrl = '';
                continue;
            }

            // SMS 验证码页
            if (url.includes('contact-verification') || url.includes('verify')) {
                console.log('[Browser] 检测到验证码页面');
                if (onSmsNeeded) {
                    const code = await onSmsNeeded();
                    if (code) {
                        await this.enterSmsCode(code);
                        lastHandledUrl = url;
                        continue;
                    }
                }
            }

            // 姓名输入
            const nameInput = pageState.inputs.find(i =>
                i.name.toLowerCase().includes('name') ||
                i.placeholder.includes('姓名') || i.placeholder.includes('全名') ||
                i.placeholder.includes('name') || i.id.includes('name')
            );
            if (nameInput) {
                console.log('[Browser] 填写姓名...');
                const sel = nameInput.id ? `#${nameInput.id}` : `input[name="${nameInput.name}"]`;
                this.logInput('register.full_name', userData.fullName, '[Phase1]');
                await this.page.type(sel, userData.fullName, { delay: 30 });
                await SLEEP(500);
                await this.clickSubmitButton();
                continue;
            }

            // 生日输入
            const dateInput = pageState.inputs.find(i =>
                i.type === 'date' || i.name.includes('birth') || i.name.includes('date') ||
                i.placeholder.includes('生日') || i.placeholder.includes('出生')
            );
            if (dateInput) {
                console.log('[Browser] 填写出生日期...');
                const sel = dateInput.id ? `#${dateInput.id}` : `input[name="${dateInput.name}"]`;
                this.logInput('register.birth_date', userData.birthDate, '[Phase1]');
                await this.page.type(sel, userData.birthDate, { delay: 30 });
                await SLEEP(500);
                await this.clickSubmitButton();
                continue;
            }

            // 同意/接受/开始按钮
            for (const btnText of ['同意', '接受', 'Agree', 'Accept', "I'm okay", '好的', '确定', '开始', '继续']) {
                try {
                    await this.clickButtonByText(btnText, 1500);
                    console.log(`[Browser] 点击了「${btnText}」`);
                    break;
                } catch (e) {}
            }
        }

        throw new Error('注册流程超时：卡在资料填写阶段，页面未继续跳转');
    }

    /**
     * 点击页面上的提交按钮（type=submit 的"继续"按钮）
     */
    async clickSubmitButton() {
        const result = await this.page.evaluate(() => {
            const labels = ['继续', 'Continue', '下一步', 'Next', '创建账号', 'Create account', 'Sign up'];
            const buttons = Array.from(document.querySelectorAll('button[type="submit"], button, [role="button"]'));
            const isVisible = (el) => {
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            };
            const isDisabled = (el) => el.disabled || el.getAttribute('aria-disabled') === 'true';
            const candidates = buttons.filter(el => isVisible(el) && !isDisabled(el));
            const target =
                candidates.find(el => labels.includes((el.innerText || el.textContent || '').trim())) ||
                candidates.find(el => el.matches('button[type="submit"]')) ||
                candidates[0];

            if (!target) {
                return {
                    clicked: false,
                    buttons: buttons.slice(0, 10).map(el => ({
                        text: (el.innerText || el.textContent || '').trim(),
                        disabled: isDisabled(el),
                        visible: isVisible(el),
                    })),
                };
            }

            target.scrollIntoView({ block: 'center', inline: 'center' });
            ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
                target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            });
            target.click?.();
            return {
                clicked: true,
                text: (target.innerText || target.textContent || '').trim(),
            };
        });

        if (result?.clicked) {
            console.log(`[Browser] 点击提交按钮: ${result.text || '(no text)'}`);
        } else {
            console.log(`[Browser] 未找到可点击提交按钮: ${JSON.stringify(result?.buttons || [])}`);
        }
        await SLEEP(3000);
    }

    async clickResendEmailButton() {
        const labels = ['重新发送电子邮件', '重新发送邮件', '重新发送', 'Resend email', 'Resend code', 'Resend'];
        console.log('[Browser] 尝试点击重新发送邮箱验证码按钮...');
        await this.clickButtonByText(labels, 5000);
        await SLEEP(3000);
        await this.waitForCloudflare(30000).catch(() => {});
        console.log('[Browser] 已触发重新发送邮箱验证码');
    }

    async clearEmailCodeInput() {
        await this.page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"])'));
            const target = inputs.find(i => i.name !== 'phoneNumberInput' && ['text', 'tel', 'number', ''].includes(i.type));
            if (!target) return false;
            target.focus();
            target.value = '';
            target.dispatchEvent(new Event('input', { bubbles: true }));
            target.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }).catch(() => false);
    }

    // ================================================================
    // Phase 1.5: 首次登录 chatgpt.com 完成 about-you
    // ================================================================

    /**
     * 登录 chatgpt.com 并完成 about-you 个人资料
     * Phase 1 注册后，首次登录需要填写全名+生日才能使用
     * @param {object} opts
     * @param {string} opts.phone - 手机号 (+44...)
     * @param {string} opts.password - 密码
     * @param {string} opts.fullName - 全名
     * @param {string} opts.birthDate - 生日 (YYYY-MM-DD)
     */
    async loginAndCompleteProfile(opts) {
        const { phone, password, fullName, birthDate, phoneCountry, onSmsNeeded } = opts;
        const resolvedPhoneCountry = this.getPhoneCountry(phoneCountry);

        // 1. 导航到 chatgpt.com
        console.log('[Phase1.5] 导航到 chatgpt.com...');
        await this.page.goto('https://chatgpt.com', {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });
        await this.waitForCloudflare();

        // 2. 等待页面渲染，检查是否已登录
        console.log('[Phase1.5] 等待页面渲染...');
        await SLEEP(5000);

        // 检查是否已登录（没有「登录」按钮说明已登录）
        const hasLoginBtn = await this.page.evaluate(() => {
            for (const b of document.querySelectorAll('button, a')) {
                const text = b.innerText.trim();
                if (text === '登录' || text === 'Log in') return true;
            }
            return false;
        });

        if (!hasLoginBtn) {
            console.log('[Phase1.5] 已处于登录状态，跳过');
            return true;
        }

        console.log('[Phase1.5] 点击「登录」...');
        await this.clickButtonByText('登录');

        // 3. 等待登录弹窗 → 选手机登录
        await this.waitForTextOnPage('登录或注册', 15000);
        await SLEEP(1000);
        console.log('[Phase1.5] 点击「继续使用手机登录」...');
        await this.clickButtonByText([
            '使用电话号码继续',
            '继续使用手机登录',
            '手机登录',
            'Continue with phone number',
            'Continue with phone',
        ], 10000);

        // 4. 输入手机号
        await this.waitFor('input[name="phoneNumberInput"]', 15000);
        await this.selectCountry(
            resolvedPhoneCountry.dialCode,
            resolvedPhoneCountry.name,
            resolvedPhoneCountry.isoCode
        );
        const localNumber = this.getLocalPhoneNumber(phone, resolvedPhoneCountry);
        await this.enterPhone(localNumber);

        // 5. 循环处理后续页面（密码、about-you、验证等）
        console.log('[Phase1.5] 开始处理登录后续步骤...');
        let lastHandledUrl = '';

        for (let round = 0; round < 20; round++) {
            await SLEEP(3000);

            let pageState;
            try {
                pageState = await this.page.evaluate(() => ({
                    inputs: Array.from(document.querySelectorAll('input:not([type="hidden"])')).map(i => ({
                        type: i.type, name: i.name, placeholder: i.placeholder,
                    })),
                    text: (document.body.innerText || '').substring(0, 800),
                    url: location.href,
                    btns: Array.from(document.querySelectorAll('button')).map(b => b.innerText.trim()).filter(t => t),
                }));
            } catch (e) {
                console.log(`[Phase1.5] Round ${round}: 页面上下文变化，等待...`);
                lastHandledUrl = '';
                continue;
            }

            const url = pageState.url;
            console.log(`[Phase1.5] Round ${round}: ${url.substring(0, 70)}`);

            // 完成：到达 ChatGPT 主页
            if (url.includes('chatgpt.com') && !url.includes('auth.openai.com')) {
                // 排除错误页面和弹窗中的情况
                if (url.includes('auth/error')) {
                    console.log(`[Phase1.5] 检测到错误页面: ${url}`);
                    // 尝试点重试或回到首页
                    try { await this.clickButtonByText('重试', 3000); } catch (e) {}
                    await SLEEP(3000);
                    lastHandledUrl = url;
                    continue;
                }
                const isMainPage = !pageState.text.includes('登录或注册')
                    && !pageState.text.includes('确认一下你的年龄')
                    && !pageState.text.includes('about-you');
                if (isMainPage) {
                    console.log('[Phase1.5] 已到达 ChatGPT 主页，登录完成！');
                    return true;
                }
            }

            if (url === lastHandledUrl) continue;

            // 密码页
            if (url.includes('password') || pageState.inputs.some(i => i.type === 'password')) {
                console.log('[Phase1.5] 填写密码...');
                await this.fillPasswordInput('input[type="password"]', password, 'phase1_5.password', '[Phase1.5]');
                await SLEEP(500);
                await this.clickSubmitButton();
                await SLEEP(3000);
                await this.waitForCloudflare(60000);
                await SLEEP(3000);
                await this.detectCredentialError('[Phase1.5]');
                lastHandledUrl = url;
                continue;
            }

            // SMS 验证码页（输入手机号后 ChatGPT 要求验证）
            if (pageState.text.includes('验证码') || pageState.text.includes('verification')
                || pageState.text.includes('code') || pageState.text.includes('短信验证')) {
                if (typeof onSmsNeeded === 'function') {
                    console.log('[Phase1.5] 检测到 SMS 验证码输入页...');
                    const smsCode = await onSmsNeeded();
                    if (smsCode) {
                        await this.enterSmsCode(smsCode);
                        await SLEEP(3000);
                        await this.waitForCloudflare(30000);
                        lastHandledUrl = url;
                        continue;
                    }
                } else {
                    console.log('[Phase1.5] 检测到验证码页，但未提供 onSmsNeeded 回调');
                }
            }

            // about-you 页面：全名 + 生日
            if (url.includes('about-you') || url.includes('about_you')
                || pageState.text.includes('确认一下你的年龄') || pageState.text.includes('你的年龄是多少')) {
                console.log('[Phase1.5] 检测到 about-you 页面...');
                const age = new Date().getFullYear() - parseInt(birthDate);
                await this.fillAboutYouAndSubmit(fullName, age, birthDate, '[Phase1.5]');
                await this.screenshot('phase1.5-about-you.png');
                lastHandledUrl = url;
                continue;
            }

            // 同意/接受/开始按钮
            for (const btnText of ['同意', '接受', 'Agree', 'Accept', "I'm okay", '好的', '确定', '开始', '继续']) {
                try {
                    await this.clickButtonByText(btnText, 1500);
                    console.log(`[Phase1.5] 点击了「${btnText}」`);
                    break;
                } catch (e) {}
            }
        }

        console.log('[Phase1.5] 登录流程完成（可能未到达主页）');
        return false;
    }

    // ================================================================
    // Phase 2: OAuth 授权
    // ================================================================

    /**
     * 导航到 OAuth 授权页面
     */
    async navigateToOAuth(authUrl) {
        console.log('[Browser] 导航到 OAuth URL...');
        let lastError = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                await this.page.goto(authUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: 60000,
                });
                lastError = null;
                break;
            } catch (error) {
                lastError = error;
                const currentUrl = this.page?.url?.() || '';
                console.warn(`[Browser] OAuth 导航第 ${attempt} 次失败: ${error.message}`);
                if (currentUrl) {
                    console.warn(`[Browser] OAuth 导航失败时页面: ${currentUrl.substring(0, 180)}`);
                }
                if (attempt >= 2) {
                    throw error;
                }
                await SLEEP(3000);
            }
        }

        if (lastError) {
            throw lastError;
        }

        await this.waitForCloudflare();
        await SLEEP(5000);
        console.log('[Browser] OAuth 页面已加载');
    }

    /**
     * OAuth 登录 + 授权完整流程（循环检测页面状态）
     * @param {object} opts
     * @param {'phone'|'email'} [opts.loginMethod] - 登录方式（默认 phone）
     * @param {boolean} [opts.stopAfterEmailBound] - 仅执行到邮箱绑定完成即返回
     * @param {string} opts.phone - 手机号（+44...）
     * @param {string} opts.email - 邮箱
     * @param {string} opts.password - 密码
     * @param {string} opts.redirectUri - OAuth 回调 URI
     * @param {function} opts.onSmsNeeded - SMS 验证码回调
     * @param {function} opts.onEmailCodeNeeded - 邮箱验证码回调
     * @returns {string} 回调 URL；当 stopAfterEmailBound=true 时，返回 'EMAIL_BOUND'
     */
    async oauthLoginAndAuthorize(opts) {
        console.log('[Browser] 开始 OAuth 登录+授权...');
        const {
            phone,
            email,
            password,
            phoneCountry,
            redirectUri,
            onSmsNeeded,
            onEmailCodeNeeded,
            loginMethod = 'phone',
            preferEmailOtp = false,
            useOneTimeCodeLogin = false,
            stopAfterEmailBound = false,
        } = opts;
        const resolvedPhoneCountry = this.getPhoneCountry(phoneCountry);
        const shouldPreferEmailOtp = !!(preferEmailOtp || useOneTimeCodeLogin);
        const redirectBase = new URL(redirectUri);
        let lastHandledUrl = '';
        let emailBound = false;

        // 监听 request 事件，捕获 localhost 回调 URL
        let capturedCallbackUrl = null;
        this.page.on('request', (req) => {
            const reqUrl = req.url();
            try {
                const u = new URL(reqUrl);
                if (u.hostname === redirectBase.hostname && u.port === redirectBase.port
                    && u.pathname === redirectBase.pathname
                    && (u.searchParams.has('code') || u.searchParams.has('error'))) {
                    capturedCallbackUrl = reqUrl;
                    console.log(`[OAuth] 捕获到回调 URL: ${reqUrl.substring(0, 80)}...`);
                }
            } catch (e) {}
        });

        // 先等页面渲染
        await SLEEP(5000);

        for (let round = 0; round < 30; round++) {
            await SLEEP(3000);

            let url, pageInfo;
            try {
                url = this.page.url();
                pageInfo = await this.page.evaluate(() => ({
                    text: (document.body?.innerText || '').substring(0, 500),
                    btns: Array.from(document.querySelectorAll('button')).map(b => b.innerText.trim()).filter(t => t),
                    inputs: Array.from(document.querySelectorAll('input:not([type="hidden"])')).map(i => ({
                        type: i.type, name: i.name, placeholder: i.placeholder,
                    })),
                    url: location.href,
                }));
                url = pageInfo.url;
            } catch (e) {
                console.log(`[OAuth] Round ${round}: 页面上下文变化...`);
                lastHandledUrl = '';
                continue;
            }

            // 检查通过 request 事件捕获的回调 URL
            if (capturedCallbackUrl) {
                console.log('[OAuth] 检测到 localhost 回调！');
                return capturedCallbackUrl;
            }

            // 也检查当前 URL（备用）
            try {
                const current = new URL(url);
                if (current.hostname === redirectBase.hostname
                    && current.port === redirectBase.port
                    && current.pathname === redirectBase.pathname
                    && (current.searchParams.has('code') || current.searchParams.has('error'))) {
                    console.log('[OAuth] 检测到 localhost 回调（URL 匹配）！');
                    return url;
                }
            } catch (e) {}

            // chrome-error 页面说明跳转到了 localhost 但连接失败，回调已在 request 事件中捕获
            if (url.includes('chrome-error')) {
                if (capturedCallbackUrl) return capturedCallbackUrl;
                // 等一下可能 request 事件还没触发
                await SLEEP(2000);
                if (capturedCallbackUrl) return capturedCallbackUrl;
            }

            // 0. 错误页面检测（「糟糕，出错了！」/ 「重试」）— URL 可能不变，需优先检测
            if (pageInfo.text.includes('出错了') || pageInfo.text.includes('went wrong')
                || pageInfo.text.includes('missing_email') || pageInfo.text.includes('error')) {
                const hasRetry = pageInfo.btns.some(b => b.includes('重试') || b.includes('Retry') || b.includes('Try again'));
                console.log(`[OAuth] Round ${round}: 检测到错误页面: ${pageInfo.text.substring(0, 150)}`);
                if (hasRetry) {
                    console.log('[OAuth] 点击「重试」...');
                    try { await this.clickButtonByText('重试', 5000); } catch (e) {
                        try { await this.clickButtonByText('Retry', 3000); } catch (e2) {}
                    }
                    await SLEEP(5000);
                    await this.waitForCloudflare(30000);
                    await SLEEP(3000);
                    lastHandledUrl = ''; // 重置，允许重新匹配
                    continue;
                }
            }

            const isEmailVerificationPage = url.includes('email-verification')
                || (loginMethod === 'email'
                    && /code|verification|验证码|收件箱/i.test(pageInfo.text)
                    && pageInfo.inputs.some(i => i.name !== 'phoneNumberInput' && (i.type === 'text' || i.type === 'tel' || i.type === 'number')));
            const hasWrongEmailCode = isEmailVerificationPage
                && /代码不正确|验证码不正确|不正确|incorrect|invalid|wrong/i.test(pageInfo.text);
            if (hasWrongEmailCode) {
                console.log('[OAuth] 检测到邮箱验证码错误，清空输入并重新发送验证码...');
                await this.clearEmailCodeInput();
                try {
                    await this.clickResendEmailButton();
                } catch (error) {
                    console.log(`[OAuth] 重新发送邮箱验证码失败，继续轮询: ${error.message}`);
                }
                lastHandledUrl = '';
                await SLEEP(3000);
            }

            if (url === lastHandledUrl) {
                console.log(`[OAuth] Round ${round}: 页面未变化...`);
                continue;
            }

            console.log(`[OAuth] Round ${round}: ${url.substring(0, 70)}`);
            console.log(`[OAuth]   按钮: ${pageInfo.btns.slice(0, 8).join(', ')}`);

            // 1. 登录/注册选择页 - 根据配置选择登录方式
            const phoneLoginTexts = ['使用电话号码继续', '继续使用手机登录', '手机登录', 'Continue with phone number', 'Continue with phone'];
            const hasPhoneLogin = pageInfo.btns.some(b => phoneLoginTexts.some(text => b.includes(text)));
            const hasEmailLogin = pageInfo.btns.some(b => b.includes('电子邮件地址登录') || b.includes('邮箱登录') || b.includes('email'));
            if (loginMethod === 'email' && hasEmailLogin) {
                console.log('[OAuth] 点击「继续使用电子邮件地址登录」...');
                try {
                    await this.clickButtonByText('电子邮件地址登录');
                } catch (e) {
                    try { await this.clickButtonByText('邮箱登录', 3000); } catch (e2) {
                        await this.clickButtonByText('email');
                    }
                }
                await SLEEP(3000);
                lastHandledUrl = url;
                continue;
            }
            if (loginMethod !== 'email' && hasPhoneLogin) {
                console.log('[OAuth] 点击「继续使用手机登录」...');
                await this.clickButtonByText(phoneLoginTexts);
                await SLEEP(3000);
                lastHandledUrl = url;
                continue;
            }

            const isChooseAccountPage =
                url.includes('/choose-an-account')
                || pageInfo.text.includes('选择帐户')
                || pageInfo.text.includes('选择账户')
                || pageInfo.text.toLowerCase().includes('choose an account');

            if (isChooseAccountPage) {
                console.log('[OAuth] 检测到 choose-an-account 页面...');
                await this.chooseExistingOAuthAccount({
                    phone,
                    fullName: opts.fullName || '',
                    tag: '[OAuth]',
                });
                lastHandledUrl = '';
                continue;
            }

            // 1.5 邮箱输入页
            const hasEmailForm = pageInfo.inputs.some(i =>
                i.type === 'email' || i.name === 'email' || i.name === 'username' || i.name === 'identifier'
            );
            if (loginMethod === 'email' && hasEmailForm) {
                console.log(`[OAuth] 检测到邮箱输入页，输入: ${email}`);
                const emailInput = await this.page.$('input[type="email"]')
                    || await this.page.$('input[name="email"]')
                    || await this.page.$('input[name="username"]')
                    || await this.page.$('input[name="identifier"]')
                    || await this.page.$('input[type="text"]');

                if (emailInput) {
                    await emailInput.click({ clickCount: 3 });
                    this.logInput('oauth.email', email, '[OAuth]');
                    await this.page.keyboard.type(email, { delay: 30 });
                }
                await SLEEP(500);
                await this.clickSubmitButton();
                await SLEEP(3000);
                await this.waitForCloudflare(30000);
                await SLEEP(3000);
                lastHandledUrl = url;
                continue;
            }

            // 2. 手机号输入页（检测方式：有国家选择器按钮 或 phoneNumberInput）
            const hasPhoneForm = pageInfo.inputs.some(i => i.name === 'phoneNumberInput' || i.type === 'tel');

            if (hasPhoneForm) {
                console.log('[OAuth] 检测到手机号输入页...');

                // 尝试选国家（方法1: select，方法2: 按钮）
                try {
                    await this.selectCountry(
                        resolvedPhoneCountry.dialCode,
                        resolvedPhoneCountry.name,
                        resolvedPhoneCountry.isoCode
                    );
                } catch (e) {}

                // 找到手机号输入框
                const input = await this.page.$('input[name="phoneNumberInput"]')
                    || await this.page.$('input[type="tel"]');

                if (input) {
                    // 检查当前国家代码是否正确
                    const currentCountry = await this.page.evaluate(() => {
                        for (const b of document.querySelectorAll('button, select')) {
                            const t = b.textContent || b.innerText || '';
                            const match = t.match(/\+(\d+)/);
                            if (match) return match[1];
                        }
                        return '';
                    });

                    await input.click({ clickCount: 3 });

                    if (resolvedPhoneCountry.dialCode && currentCountry === resolvedPhoneCountry.dialCode) {
                        // 国家正确，只输入本地号码
                        const localNumber = this.getLocalPhoneNumber(phone, resolvedPhoneCountry);
                        this.logInput('oauth.phone.local_number', localNumber, '[OAuth]');
                        await input.type(localNumber, { delay: 50 });
                        console.log(`[OAuth] 输入本地号码: ${localNumber} (国家 +${resolvedPhoneCountry.dialCode})`);
                    } else {
                        // 国家不对，输入完整号码（去掉 + 号）
                        const fullNumber = phone.replace(/^\+/, '');
                        this.logInput('oauth.phone.full_number', fullNumber, '[OAuth]');
                        await input.type(fullNumber, { delay: 50 });
                        console.log(`[OAuth] 输入完整号码: ${fullNumber} (国家显示 +${currentCountry})`);
                    }
                }
                await SLEEP(500);
                await this.screenshot('oauth-phone.png');

                // 精确点击 type=submit 的「继续」按钮（避免匹配 Google 等按钮）
                await this.page.evaluate(() => {
                    for (const b of document.querySelectorAll('button[type="submit"]')) {
                        const text = b.innerText.trim();
                        if (text === '继续' || text === 'Continue') {
                            ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
                                b.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
                            });
                            return;
                        }
                    }
                });
                await SLEEP(3000);
                await this.waitForCloudflare(30000);
                await SLEEP(5000);
                lastHandledUrl = url; // 标记已处理，避免重复
                continue;
            }

            // 3. 密码页
            
            if (pageInfo.inputs.some(i => i.type === 'password') || url.includes('password')) {
                if (loginMethod === 'email' && shouldPreferEmailOtp) {
                    const switchedToOtp = await this.page.evaluate(() => {
                        const candidates = [
                            '使用一次性验证码登录',
                            '一次性验证码登录',
                            '一次性验证码',
                            'one-time code',
                            'one time code',
                            'email code',
                            'send code',
                            'use code',
                            'magic code',
                            'try another way',
                            'verification code',
                        ];
                        const nodes = document.querySelectorAll('button, a, [role="button"]');
                        for (const node of nodes) {
                            const text = (node.innerText || node.textContent || '').trim().toLowerCase();
                            if (!text) continue;
                            if (candidates.some(c => text.includes(c))) {
                                ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
                                    node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
                                });
                                return true;
                            }
                        }
                        return false;
                    });

                    if (switchedToOtp) {
                        console.log('[OAuth] switched to one-time code login');
                        await SLEEP(4000);
                        await this.waitForCloudflare(30000);
                        await SLEEP(2000);
                        lastHandledUrl = url;
                        continue;
                    }

                    // 已要求走一次性验证码登录时，不再回退输入密码
                    throw new Error('已启用一次性验证码登录，但当前页面未找到「使用一次性验证码登录」入口');
                }

                if (!password) {
                    throw new Error('password page shown but password is empty');
                }

                console.log('[OAuth] 检测到密码页，准备输入密码并继续...');
                await this.fillPasswordInput('input[type="password"]', password, 'oauth.password', '[OAuth]');
                await SLEEP(500);
                // 先尝试回车提交（OpenAI 登录页通常支持）
                await this.page.keyboard.press('Enter').catch(() => {});
                await SLEEP(1000);

                // 再用真实鼠标点击可见的提交按钮（避免仅 dispatchEvent 未触发）
                const submitBtnPos = await this.page.evaluate(() => {
                    const preferredTexts = ['继续', 'Continue', 'Next', 'Verify', 'Submit'];
                    const submitButtons = Array.from(document.querySelectorAll('button[type="submit"], button'));

                    for (const b of submitButtons) {
                        const text = (b.innerText || '').trim();
                        if (!preferredTexts.some(t => text === t || text.includes(t))) continue;
                        if (b.disabled) continue;
                        const rect = b.getBoundingClientRect();
                        if (rect.width <= 0 || rect.height <= 0) continue;
                        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text };
                    }

                    for (const b of submitButtons) {
                        if (b.disabled) continue;
                        const rect = b.getBoundingClientRect();
                        if (rect.width <= 0 || rect.height <= 0) continue;
                        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text: (b.innerText || '').trim() || 'submit' };
                    }

                    return null;
                });

                if (submitBtnPos) {
                    console.log(`[OAuth] 点击密码页按钮: ${submitBtnPos.text}`);
                    await this.page.mouse.click(submitBtnPos.x, submitBtnPos.y);
                } else {
                    await this.clickSubmitButton();
                }
                await SLEEP(5000);
                await this.waitForCloudflare(30000);
                await SLEEP(3000);
                await this.detectCredentialError('[OAuth]');
                lastHandledUrl = url;
                continue;
            }

            // 3.5 about-you 页面：填写个人信息并继续
            if (url.includes('about-you') || url.includes('about_you')) {
                console.log('[OAuth] 检测到 about-you 页面...');
                await this.fillAboutYouAndSubmit(
                    opts.fullName || opts.phone,
                    opts.age || 30,
                    opts.birthDate,
                    '[OAuth]'
                );
                await this.screenshot('oauth-about-you-filled.png');
                lastHandledUrl = url;
                continue;
            }

            // 3.6 添加邮箱页 (add-email)
            if (url.includes('add-email') || url.includes('add_email')) {
                console.log(`[OAuth] 检测到邮箱绑定页面，输入: ${email}`);
                const emailInput = await this.page.$('input[type="email"]')
                    || await this.page.$('input[name="email"]')
                    || await this.page.$('input[type="text"]');
                if (emailInput) {
                    await emailInput.click({ clickCount: 3 });
                    this.logInput('oauth.bind_email', email, '[OAuth]');
                    await this.page.keyboard.type(email, { delay: 30 });
                }
                await SLEEP(500);
                await this.clickSubmitButton();
                await SLEEP(5000);
                await this.waitForCloudflare(30000);
                await SLEEP(3000);
                emailBound = true;
                lastHandledUrl = url;
                continue;
            }

            // 4a. 邮箱验证码页（email-verification）
            
            if (isEmailVerificationPage) {
                console.log('[OAuth] 检测到邮箱验证码页面，准备读取并填写验证码...');
                if (onEmailCodeNeeded) {
                    const code = await onEmailCodeNeeded({
                        resendEmail: async () => {
                            await this.clickResendEmailButton();
                        },
                    });
                    if (code) {
                        await this.enterSmsCode(code);
                        await this.screenshot('after-email-code.png');
                        emailBound = true;
                        lastHandledUrl = url;
                        continue;
                    }
                }
            }

            // 4c. 当已完成邮箱绑定且配置要求提前结束时，直接返回
            if (stopAfterEmailBound && emailBound) {
                const atConsentPage = url.includes('/consent') || pageInfo.btns.some(b => b === '继续' || b === 'Continue');
                const leftEmailBindingPage = !url.includes('add-email') && !url.includes('add_email') && !url.includes('email-verification');
                if (atConsentPage || leftEmailBindingPage) {
                    console.log('[OAuth] 邮箱绑定流程已完成，按配置提前返回');
                    return 'EMAIL_BOUND';
                }
            }

            // 4b. SMS 验证码页（contact-verification）
            
            if (url.includes('contact-verification')) {
                console.log('[OAuth] 需要 SMS 验证码...');
                if (onSmsNeeded) {
                    const code = await onSmsNeeded();
                    if (code) {
                        await this.enterSmsCode(code);
                        lastHandledUrl = url;
                        continue;
                    }
                }
            }

            // 5. 授权确认页 - 点击授权/允许按钮（精确匹配，避免 Google/Apple 等）
            const safeClick = await this.page.evaluate(() => {
                const skipWords = ['Google', 'Apple', 'Microsoft', '邮件', '邮箱', '手机', 'email', 'phone'];
                for (const b of document.querySelectorAll('button')) {
                    const text = b.innerText.trim();
                    if (!text) continue;
                    // 只点击短文本按钮（授权/允许/继续），排除包含第三方登录关键词的
                    if (text.length <= 10 && !skipWords.some(w => text.includes(w))) {
                        if (['Allow', '授权', '允许', '同意', 'Continue', '继续'].some(t => text.includes(t))) {
                            ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
                                b.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
                            });
                            return text;
                        }
                    }
                }
                return null;
            });
            if (safeClick) {
                console.log(`[OAuth] 点击了「${safeClick}」`);
                lastHandledUrl = url;
            }

            // 每5轮截图诊断
            if (round % 5 === 4) {
                await this.screenshot(`oauth-round${round}.png`);
                // 打印页面文字帮助诊断
                console.log(`[OAuth] 页面文字: ${pageInfo.text.substring(0, 150)}`);
            }
        }

        throw new Error('OAuth 登录+授权超时');
    }
}

module.exports = { BrowserService };



