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
const jsonParser = bodyParser.json();

let isShuttingDown = false;
let activeRequests = 0;

const crudStats = {
    create: 0,
    read: 0,
    delete: 0
};


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

app.get('/whoami', (req, res) => {
    res.json({
        id: selfId,
        port: PORT,
        state: raft.state,
        leader: raft.leaderId
    });
});

app.post('/internal/replicate', jsonParser, async (req, res) => {
    const { key, value } = req.body;
    try {
        await store.saveKeyValue(dataDir, key, value);
        crudStats.create++;
        logger.info(`[${selfId}] 📄 Репликация ключа ${key}`);
        res.send({ status: 'ok' });
    } catch (err) {
        logger.error(`[${selfId}] ❌ Ошибка репликации: ${err.message}`);
        res.status(500).send({ status: 'error' });
    }
});

app.post('/internal/delete', jsonParser, async (req, res) => {
    const { key } = req.body;
    try {
        await store.deleteKeyValue(dataDir, key);
        crudStats.delete++;
        logger.info(`[${selfId}] 🧨 Репликация удаления ${key}`);
        res.send({ status: 'ok' });
    } catch (err) {
        logger.error(`[${selfId}] ❌ Ошибка при удалении реплики: ${err.message}`);
        res.status(500).send({ status: 'error' });
    }
});

async function redirectIfNotLeader(req, res, next) {
    logger.info(`[${selfId}] 🧭 redirectIfNotLeader → state: ${raft.state}, leaderId: ${raft.leaderId}`);

    if (raft.state === 'leader') {
        logger.info(`[${selfId}] ✅ Я лидер, продолжаем`);
        return next();
    }

    if (!raft.leaderId) {
        logger.warn(`[${selfId}] ❌ Нет информации о лидере`);
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

        const result = await axios({
            method: req.method,
            url: targetUrl,
            data: req.body,
            headers: { ...req.headers, Connection: 'close' },
            validateStatus: () => true
        });

        res.status(result.status).set(result.headers).send(result.data);
    } catch (err) {
        logger.error(`[${selfId}] ❌ Не удалось перенаправить на лидера: ${err.message}`);
        res.status(502).send('Ошибка при редиректе на лидера');
    }
}

app.post('/key', redirectIfNotLeader, jsonParser, async (req, res) => {
    const { key, value } = req.body;

    logger.info(`[${selfId}] 🔥 POST /key с телом: ${JSON.stringify(req.body)}`);

    if (!key || value === undefined) {
        logger.warn(`[${selfId}] ❌ Неполные данные: key=${key}, value=${value}`);
        return res.status(400).send('❌ Нужны key и value');
    }

    try {
        await store.saveKeyValue(dataDir, key, value);
        crudStats.create++;
        logger.info(`[${selfId}] ✅ Лидер сохранил: ${key}`);

        const nodeId = raft.getNodeId();
        const node = require('../../configuration.json').nodes.find(n => n.id === nodeId);
        const myUrl = `http://localhost:${PORT}`;
        const followers = node.servers.map(s => `http://localhost:${s.port}`).filter(url => url !== myUrl);

        const results = await Promise.allSettled(
            followers.map(url => axios.post(`${url}/internal/replicate`, { key, value }, {
                timeout: 1500,
                headers: { Connection: 'close' }
            }))
        );

        const failed = results.filter(r => r.status !== 'fulfilled');
        if (failed.length > 0) {
            return res.status(207).json({
                resp: {
                    error: {
                        code: 'eREPL01',
                        errno: 207,
                        message: 'Не все фолловеры подтвердили сохранение'
                    },
                    data: 0
                }
            });
        }

        res.json({
            resp: {
                error: 0,
                data: {
                    message: 'Сохранено и реплицировано',
                    key,
                    node: nodeId
                }
            }
        });
    } catch (err) {
        logger.error(`[${selfId}] ❌ Ошибка при сохранении: ${err.message}`);
        res.status(500).json({
            resp: {
                error: {
                    code: 'eSAVE01',
                    errno: 500,
                    message: err.message
                },
                data: 0
            }
        });
    }
});

app.get('/key/:key', async (req, res) => {
    const key = req.params.key;

    try {
        const exists = await store.keyExists(dataDir, key);
        if (!exists) {
            return res.status(404).json({ error: 0, data: '❌ Ключ не найден' });
        }

        const data = await store.readKeyValue(dataDir, key);
        crudStats.read++;
        if (!data || typeof data !== 'object' || !data.key || !data.value) {
            logger.error(`[${selfId}] ❌ Невалидный формат файла для ключа ${key}`);
            return res.status(500).json({ error: 1, message: 'Невалидный JSON' });
        }

        res.json(data);
    } catch (err) {
        logger.error(`[${selfId}] ❌ Ошибка при чтении ключа: ${err.message}`);
        res.status(500).json({ error: 1, message: err.message });
    }
});

app.delete('/key/:key', redirectIfNotLeader, async (req, res) => {
    const key = req.params.key;

    try {
        await store.deleteKeyValue(dataDir, key);
        crudStats.delete++;
        logger.info(`[${selfId}] 🗑 Удалён локально: ${key}`);

        const nodeId = raft.getNodeId();
        const node = require('../../configuration.json').nodes.find(n => n.id === nodeId);
        const myUrl = `http://localhost:${PORT}`;
        const followers = node.servers.map(s => `http://localhost:${s.port}`).filter(url => url !== myUrl);

        const results = await Promise.allSettled(
            followers.map(url =>
                axios.post(`${url}/internal/delete`, { key }, {
                    timeout: 1500,
                    headers: { Connection: 'close' }
                })
            )
        );

        const failed = results.filter(r => r.status !== 'fulfilled');
        if (failed.length > 0) {
            logger.warn(`[${selfId}] ⚠️ Репликация удаления частично не удалась (${failed.length})`);
            return res.status(207).json({
                resp: {
                    error: {
                        code: 'eREPLDEL01',
                        errno: 207,
                        message: 'Удалено, но не у всех фолловеров'
                    },
                    data: 0
                }
            });
        }

        res.json({
            resp: {
                error: 0,
                data: {
                    message: 'Удалено и синхронизировано',
                    key,
                    node: nodeId
                }
            }
        });
    } catch (err) {
        logger.error(`[${selfId}] ❌ Ошибка удаления: ${err.message}`);
        res.status(500).json({
            resp: {
                error: {
                    code: 'eDEL01',
                    errno: 500,
                    message: err.message
                },
                data: 0
            }
        });
    }
});

app.post('/raft/vote', jsonParser, (req, res) => {
    raft.handleVoteRequest(req, res);
});

app.post('/raft/heartbeat', jsonParser, (req, res) => {
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

app.get('/internal/shutdown', (req, res) => {
    logger.info(`[${selfId}] ⛔ Получен сигнал остановки`);
    isShuttingDown = true;
    res.send('Остановка начата, ждём завершения операций...');
});

app.get('/stats', (req, res) => {
    res.json({
        id: selfId,
        stats: crudStats
    });
});


app.listen(PORT, async () => {
    await fs.ensureDir(dataDir);
    logger.info(`[${selfId}] 🚀 Server is running on ${PORT}`);
});
