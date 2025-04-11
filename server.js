// server.js
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs-extra');
const fsSync = require('fs');
const RaftNode = require('./raft');
const logger = require('./logger');
const store = require('./fileStore');
const path = require('path');

// 🔧 Получаем путь к конфигу
const configPath = process.argv[2];
if (!configPath) {
    console.error('❌ Укажи путь к конфигу: node server.js configs/nodeA/server1.json');
    process.exit(1);
}

const config = JSON.parse(fsSync.readFileSync(configPath, 'utf-8'));

const PORT = config.port;
const selfId = config.id;
const peers = config.peers || [];
const dataDir = config.dataDir;
const raft = new RaftNode(config);


const app = express();
app.use(bodyParser.json());

let isShuttingDown = false;
let activeRequests = 0;

// Middleware: блок новых запросов при завершении
app.use((req, res, next) => {
    if (isShuttingDown) {
        return res.status(503).send('⛔ Сервер выключается');
    }
    activeRequests++;
    res.on('finish', () => {
        activeRequests--;
        if (isShuttingDown && activeRequests === 0) {
            logger.info(`[${selfId}] ✅ Все операции завершены. Завершаем процесс.`);
            process.exit(0);
        }
    });
    next();
});

// ➕ POST /key — сохранить key-value
app.post('/key', async (req, res) => {
    const { key, value } = req.body;
    if (!key || value === undefined) {
        return res.status(400).send('❌ Нужны key и value');
    }

    try {
        await store.saveKeyValue(dataDir, key, value);
        logger.info(`[${selfId}] ✅ Сохранено: ${key}`);
        res.send('Сохранено');
    } catch (err) {
        res.status(500).send('Ошибка при сохранении');
    }
});

// 🔍 GET /key/:key — получить значение
app.get('/key/:key', async (req, res) => {
    const key = req.params.key;

    try {
        const exists = await store.keyExists(dataDir, key);
        if (!exists) {
            return res.status(404).send('❌ Ключ не найден');
        }

        const data = await store.readKeyValue(dataDir, key);
        res.json(data);
    } catch (err) {
        res.status(500).send('Ошибка при чтении');
    }
});

// 🗑 DELETE /key/:key — удалить значение
app.delete('/key/:key', async (req, res) => {
    const key = req.params.key;

    try {
        await store.deleteKeyValue(dataDir, key);
        logger.info(`[${selfId}] 🗑 Удалён ключ: ${key}`);
        res.send('Удалено');
    } catch (err) {
        res.status(500).send('Ошибка при удалении');
    }
});

// ⛔ /internal/shutdown — для graceful stop
app.get('/internal/shutdown', (req, res) => {
    logger.info(`[${selfId}] ⛔ Получен сигнал остановки`);
    isShuttingDown = true;
    res.send('Остановка начата, ждём завершения операций...');
});

// 🔍 /key/ping — проверка доступности сервера
app.get('/key/ping', (req, res) => {
    res.send('🟢 Я жив!');
});

// 📩 POST /raft/vote — Получить запрос голоса
app.post('/raft/vote', (req, res) => {
    raft.handleVoteRequest(req, res);
});

// ❤️ POST /raft/heartbeat — Получить heartbeat от лидера
app.post('/raft/heartbeat', (req, res) => {
    raft.handleHeartbeat(req, res);
});

app.get('/raft/status', (req, res) => {
    res.json({
        id: raft.id,
        state: raft.state,
        term: raft.currentTerm
    });
});

// 🟢 Старт
app.listen(PORT, async () => {
    await fs.ensureDir(dataDir);
    logger.info(`[${selfId}] 🚀 Сервер запущен на порту ${PORT}`);
});
