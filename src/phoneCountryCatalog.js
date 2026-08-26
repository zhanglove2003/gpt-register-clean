const DEFAULT_PHONE_COUNTRIES = [
    { isoCode: 'GB', dialCode: '44', name: '英国', aliases: ['United Kingdom', 'UK', 'Britain', 'Great Britain'] },
    { isoCode: 'US', dialCode: '1', name: '美国', aliases: ['United States', 'USA', 'America'] },
    { isoCode: 'CA', dialCode: '1', name: '加拿大', aliases: ['Canada'] },
    { isoCode: 'AU', dialCode: '61', name: '澳大利亚', aliases: ['Australia'] },
    { isoCode: 'NZ', dialCode: '64', name: '新西兰', aliases: ['New Zealand'] },
    { isoCode: 'IE', dialCode: '353', name: '爱尔兰', aliases: ['Ireland'] },
    { isoCode: 'DE', dialCode: '49', name: '德国', aliases: ['Germany', 'Deutschland'] },
    { isoCode: 'FR', dialCode: '33', name: '法国', aliases: ['France'] },
    { isoCode: 'ES', dialCode: '34', name: '西班牙', aliases: ['Spain'] },
    { isoCode: 'IT', dialCode: '39', name: '意大利', aliases: ['Italy'] },
    { isoCode: 'NL', dialCode: '31', name: '荷兰', aliases: ['Netherlands', 'Holland'] },
    { isoCode: 'BE', dialCode: '32', name: '比利时', aliases: ['Belgium'] },
    { isoCode: 'AT', dialCode: '43', name: '奥地利', aliases: ['Austria'] },
    { isoCode: 'CH', dialCode: '41', name: '瑞士', aliases: ['Switzerland'] },
    { isoCode: 'SE', dialCode: '46', name: '瑞典', aliases: ['Sweden'] },
    { isoCode: 'NO', dialCode: '47', name: '挪威', aliases: ['Norway'] },
    { isoCode: 'DK', dialCode: '45', name: '丹麦', aliases: ['Denmark'] },
    { isoCode: 'FI', dialCode: '358', name: '芬兰', aliases: ['Finland'] },
    { isoCode: 'PL', dialCode: '48', name: '波兰', aliases: ['Poland'] },
    { isoCode: 'PT', dialCode: '351', name: '葡萄牙', aliases: ['Portugal'] },
    { isoCode: 'CZ', dialCode: '420', name: '捷克', aliases: ['Czech Republic', 'Czechia'] },
    { isoCode: 'GR', dialCode: '30', name: '希腊', aliases: ['Greece'] },
    { isoCode: 'RO', dialCode: '40', name: '罗马尼亚', aliases: ['Romania'] },
    { isoCode: 'HU', dialCode: '36', name: '匈牙利', aliases: ['Hungary'] },
    { isoCode: 'TR', dialCode: '90', name: '土耳其', aliases: ['Turkey', 'Turkiye'] },
    { isoCode: 'IL', dialCode: '972', name: '以色列', aliases: ['Israel'] },
    { isoCode: 'AE', dialCode: '971', name: '阿联酋', aliases: ['UAE', 'United Arab Emirates'] },
    { isoCode: 'SA', dialCode: '966', name: '沙特阿拉伯', aliases: ['Saudi Arabia'] },
    { isoCode: 'SG', dialCode: '65', name: '新加坡', aliases: ['Singapore'] },
    { isoCode: 'MY', dialCode: '60', name: '马来西亚', aliases: ['Malaysia'] },
    { isoCode: 'TH', dialCode: '66', name: '泰国', aliases: ['Thailand'] },
    { isoCode: 'VN', dialCode: '84', name: '越南', aliases: ['Vietnam'] },
    { isoCode: 'PH', dialCode: '63', name: '菲律宾', aliases: ['Philippines'] },
    { isoCode: 'ID', dialCode: '62', name: '印度尼西亚', aliases: ['Indonesia'] },
    { isoCode: 'IN', dialCode: '91', name: '印度', aliases: ['India'] },
    { isoCode: 'JP', dialCode: '81', name: '日本', aliases: ['Japan'] },
    { isoCode: 'KR', dialCode: '82', name: '韩国', aliases: ['South Korea', 'Korea Republic'] },
    { isoCode: 'HK', dialCode: '852', name: '中国香港', aliases: ['Hong Kong'] },
    { isoCode: 'TW', dialCode: '886', name: '中国台湾', aliases: ['Taiwan'] },
    { isoCode: 'BR', dialCode: '55', name: '巴西', aliases: ['Brazil'] },
    { isoCode: 'MX', dialCode: '52', name: '墨西哥', aliases: ['Mexico'] },
    { isoCode: 'AR', dialCode: '54', name: '阿根廷', aliases: ['Argentina'] },
    { isoCode: 'CL', dialCode: '56', name: '智利', aliases: ['Chile'] },
    { isoCode: 'CO', dialCode: '57', name: '哥伦比亚', aliases: ['Colombia'] },
    { isoCode: 'PE', dialCode: '51', name: '秘鲁', aliases: ['Peru'] },
    { isoCode: 'ZA', dialCode: '27', name: '南非', aliases: ['South Africa'] },
    { isoCode: 'EG', dialCode: '20', name: '埃及', aliases: ['Egypt'] },
    { isoCode: 'NG', dialCode: '234', name: '尼日利亚', aliases: ['Nigeria'] },
];

function normalizePhoneCountries(list = []) {
    return list
        .filter(item => item && typeof item === 'object')
        .map((item) => {
            const isoCode = String(item.isoCode || item.iso || '').trim().toUpperCase();
            const dialCode = String(item.dialCode || item.phoneCode || '').replace(/^\+/, '').trim();
            const name = String(item.name || item.country || '').trim();
            const aliases = Array.isArray(item.aliases)
                ? item.aliases.map(v => String(v || '').trim()).filter(Boolean)
                : [];
            const hasHeroSmsCountry = item.heroSmsCountry !== undefined
                && item.heroSmsCountry !== null
                && String(item.heroSmsCountry).trim() !== '';
            const heroSmsCountry = hasHeroSmsCountry && Number.isFinite(Number(item.heroSmsCountry))
                ? Number(item.heroSmsCountry)
                : null;

            if (!isoCode || !dialCode || !name) {
                return null;
            }

            return {
                isoCode,
                dialCode,
                name,
                aliases,
                heroSmsCountry,
            };
        })
        .filter(Boolean);
}

module.exports = {
    DEFAULT_PHONE_COUNTRIES,
    normalizePhoneCountries,
};
