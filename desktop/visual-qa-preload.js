const { contextBridge } = require('electron');

let summary = {
  projectRoot: 'D:/Codex/projects/gpt_register-workcopy',
  configPath: 'D:/Codex/projects/gpt_register-workcopy/config.json',
  config: {},
  issues: [],
  counts: { accounts: 3, usernames: 2, tokens: 1 },
  isRunning: false,
  logs: [],
};
let heroOverview = { ok: true, balance: 1.96, service: 'dr', countryCount: 0, countries: [], refreshedAt: new Date().toISOString() };
const logListeners = new Set();
const stateListeners = new Set();

contextBridge.exposeInMainWorld('desktopApi', {
  getSummary: async () => summary,
  saveConfig: async (config) => {
    summary = { ...summary, config: { ...summary.config, ...config }, issues: [] };
    return { ok: true, config: summary.config, issues: [] };
  },
  openProjectFolder: async () => ({ ok: true }),
  getHeroSmsOverview: async () => heroOverview,
  testMail: async () => ({ ok: true, address: 'desktop@example.com', inboxReachable: true, count: 0 }),
  startRun: async () => ({ ok: true, pid: 12345 }),
  stopRun: async () => ({ ok: true }),
  onRuntimeLog: (callback) => {
    logListeners.add(callback);
    return () => logListeners.delete(callback);
  },
  onRuntimeState: (callback) => {
    stateListeners.add(callback);
    return () => stateListeners.delete(callback);
  },
});

contextBridge.exposeInMainWorld('__visualQaSetData', (nextSummary, nextHeroOverview) => {
  summary = nextSummary;
  heroOverview = nextHeroOverview;
});

