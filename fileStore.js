// fileStore.js
const fs = require('fs-extra');
const path = require('path');
const md5 = require('md5');
const logger = require('./logger');

function getFilePath(dataDir, key) {
    return path.join(dataDir, `${md5(key)}.json`);
}

async function saveKeyValue(dataDir, key, value) {
    const filePath = getFilePath(dataDir, key);
    try {
        await fs.outputJson(filePath, { key, value });
        logger.info(`💾 Сохранено: ${key} → ${filePath}`);
    } catch (err) {
        logger.error(`❌ Ошибка при сохранении ${key}: ${err}`);
        throw err;
    }
}

async function readKeyValue(dataDir, key) {
    const filePath = getFilePath(dataDir, key);
    try {
        const data = await fs.readJson(filePath);
        logger.info(`📖 Прочитано: ${key} → ${filePath}`);
        return data;
    } catch (err) {
        logger.error(`❌ Ошибка при чтении ${key}: ${err}`);
        throw err;
    }
}

async function deleteKeyValue(dataDir, key) {
    const filePath = getFilePath(dataDir, key);
    try {
        await fs.remove(filePath);
        logger.info(`🗑 Удалён ключ: ${key}`);
    } catch (err) {
        logger.error(`❌ Ошибка при удалении ${key}: ${err}`);
        throw err;
    }
}

async function keyExists(dataDir, key) {
    const filePath = getFilePath(dataDir, key);
    return fs.pathExists(filePath);
}

module.exports = {
    saveKeyValue,
    readKeyValue,
    deleteKeyValue,
    keyExists
};
