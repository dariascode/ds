const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs-extra');
const fsSync = require('fs');
const axios = require('axios');
const RaftNode = require('./raft');
const createLogger = require('../logger/logger');
const logger = createLogger({ type: 'crud' });
const store = require('./fileStore');
const path = require('path');

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

app.get('/key/ping', (req, res) => {
    res.send('🟢 Я жив!');
});

async function redirectIfNotLeader(req, res, next) {
    if (raft.state === 'leader') {
        return next();
    }

    if (!raft.leaderId) {
        return res.status(503).send('❌ Нет информации о лидере');
    }

    const selfUrl = `http://localhost:${PORT}`;
    if (raft.leaderId === selfUrl) {
        logger.warn(`[${selfId}] ⚠️ Я думаю, что я не лидер, но leaderId указывает на меня`);
        return next();
    }

    try {
        const leaderBase = raft.leaderId.replace(/\/$/, '');
        const targetUrl = leaderBase + req.originalUrl;
        logger.warn(`[${selfId}] 🔀 Перенаправляем на лидера: ${targetUrl}`);

        const options = {
            method: req.method,
            headers: {
                ...req.headers,
                Connection: 'close' // фикс для закрытия keep-alive
            },
            data: req.body,
            url: targetUrl,
            validateStatus: () => true
        };

        const result = await axios(options);
        res.status(result.status).set(result.headers).send(result.data);
    } catch (err) {
        logger.error(`[${selfId}] ❌ Не удалось перенаправить на лидера: ${err.message}`);
        res.status(502).send('Ошибка при редиректе на лидера');
    }
}

app.post('/key', redirectIfNotLeader, async (req, res) => {
    const { key, value } = req.body;

    logger.info(`[${selfId}] 🔥 POST /key с телом: ${JSON.stringify(req.body)}`);

    if (!key || value === undefined) {
        logger.warn(`[${selfId}] ❌ Неполные данные: key=${key}, value=${value}`);
        return res.status(400).send('❌ Нужны key и value');
    }

    try {
        await store.saveKeyValue(dataDir, key, value);
        logger.info(`[${selfId}] ✅ Сохранено: ${key}`);
        res.send('Сохранено');
    } catch (err) {
        logger.error(`[${selfId}] ❌ Ошибка при сохранении: ${err.message}`);
        console.error(err);
        res.status(500).send('Ошибка при сохранении');
    }
});

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

app.delete('/key/:key', redirectIfNotLeader, async (req, res) => {
    const key = req.params.key;

    try {
        await store.deleteKeyValue(dataDir, key);
        logger.info(`[${selfId}] 🗑 Удалён ключ: ${key}`);
        res.send('Удалено');
    } catch (err) {
        res.status(500).send('Ошибка при удалении');
    }
});

app.get('/internal/shutdown', (req, res) => {
    logger.info(`[${selfId}] ⛔ Получен сигнал остановки`);
    isShuttingDown = true;
    res.send('Остановка начата, ждём завершения операций...');
});

app.post('/raft/vote', (req, res) => {
    raft.handleVoteRequest(req, res);
});

app.post('/raft/heartbeat', (req, res) => {
    raft.handleHeartbeat(req, res);
});

app.get('/raft/status', (req, res) => {
    res.json({
        id: raft.id,
        state: raft.state,
        term: raft.currentTerm,
        leader: raft.leaderId
    });
});

app.listen(PORT, async () => {
    await fs.ensureDir(dataDir);
    logger.info(`[${selfId}] 🚀 Server is running on ${PORT}`);
});
