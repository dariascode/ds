// fileStore.js
const fs = require('fs-extra');
const path = require('path');
const md5 = require('md5');
const createLogger = require('../logger/logger');
const logger = createLogger({ type: 'crud' });

function getFilePath(dataDir, key) {
    return path.join(dataDir, `${md5(key)}.json`);
}

async function saveKeyValue(dataDir, key, value) {
    const filePath = getFilePath(dataDir, key);
    try {
        await fs.outputJson(filePath, { key, value });
        logger.info(`💾 Saved:  ${key} → ${filePath}`);
    } catch (err) {
        logger.error(`❌ Error in saving: ${key}: ${err}`);
        throw err;
    }
}

async function readKeyValue(dataDir, key) {
    const filePath = getFilePath(dataDir, key);
    try {
        const data = await fs.readJson(filePath);
        logger.info(`📖 Read:  ${key} → ${filePath}`);
        return data;
    } catch (err) {
        logger.error(`❌ Error in reading:  ${key}: ${err}`);
        throw err;
    }
}

async function deleteKeyValue(dataDir, key) {
    const filePath = getFilePath(dataDir, key);
    try {
        await fs.remove(filePath);
        logger.info(`🗑 Key is deleted:  ${key}`);
    } catch (err) {
        logger.error(`❌ Error in deleting:  ${key}: ${err}`);
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
