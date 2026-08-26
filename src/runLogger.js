const fs = require('fs');
const path = require('path');
const util = require('util');

let initialized = false;
let stream = null;
let logFilePath = '';
let originals = null;

function pad(num) {
    return String(num).padStart(2, '0');
}

function formatTimestamp(date = new Date()) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatFileTimestamp(date = new Date()) {
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function writeLine(level, message) {
    if (!stream) return;
    stream.write(`[${formatTimestamp()}] [${level}] ${message}\n`);
}

function installConsoleTee() {
    if (originals) return;
    originals = {
        log: console.log.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
    };

    for (const [level, fnName] of [
        ['LOG', 'log'],
        ['INFO', 'info'],
        ['WARN', 'warn'],
        ['ERROR', 'error'],
    ]) {
        console[fnName] = (...args) => {
            const rendered = util.formatWithOptions({ colors: false, depth: 8 }, ...args);
            writeLine(level, rendered);
            originals[fnName](...args);
        };
    }
}

function initRunLogger(projectDir = process.cwd()) {
    if (initialized) {
        return { logFilePath };
    }

    const logsDir = path.join(projectDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    logFilePath = path.join(logsDir, `run-${formatFileTimestamp()}.log`);
    stream = fs.createWriteStream(logFilePath, { flags: 'a' });
    installConsoleTee();
    initialized = true;

    process.on('uncaughtException', (error) => {
        writeLine('FATAL', `uncaughtException: ${error?.stack || error?.message || error}`);
    });
    process.on('unhandledRejection', (reason) => {
        writeLine('FATAL', `unhandledRejection: ${reason?.stack || reason?.message || reason}`);
    });

    writeLine('INFO', `log file created at ${logFilePath}`);
    return { logFilePath };
}

function logInputValue(field, value, context = '') {
    const fieldName = String(field || 'unknown');
    const renderedValue = typeof value === 'string' ? value : JSON.stringify(value);
    const extra = context ? ` | ${context}` : '';
    writeLine('INPUT', `${fieldName} = ${renderedValue}${extra}`);
}

function getLogFilePath() {
    return logFilePath;
}

module.exports = {
    getLogFilePath,
    initRunLogger,
    logInputValue,
};
