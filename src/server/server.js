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
const md5 = require('md5');

const configPath = process.argv[2];
if (!configPath) {
    console.error('❌ Path for config required:  node server.js configs/nodeA/server1.json');
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
        return res.status(503).send('⛔ Server is stopping');
    }
    activeRequests++;
    res.on('finish', () => {
        activeRequests--;
        if (isShuttingDown && activeRequests === 0) {
            logger.info(`[${selfId}] ✅ All of the processes are done. Stop the server`);
            process.exit(0);
        }
    });
    next();
});

app.get('/key/ping', (req, res) => {
    res.send('🟢 ALIVE!');
});

app.get('/whoami', (req, res) => {
    res.json({
        id: selfId,
        port: PORT,
        state: raft.state,
        leader: raft.leaderId
    });
});

app.post('/internal/prepare', jsonParser, async (req, res) => {
    const { key, value, operation } = req.body;
    try {
        const tmp = path.join(dataDir, `${md5(key)}.${operation}.prepare`);
        await fs.outputJson(tmp, { key, value });
        logger.info(`[${selfId}] 🟡 PREPARE ${operation} ${key}`);
        res.send({ status: 'ready' });
    } catch (err) {
        logger.error(`[${selfId}] ❌ PREPARE FAILED: ${err.message}`);
        res.status(500).send({ status: 'fail' });
    }
});

app.post('/internal/commit', jsonParser, async (req, res) => {
    const { key, operation } = req.body;
    try {
        const tmp = path.join(dataDir, `${md5(key)}.${operation}.prepare`);
        const { value } = await fs.readJson(tmp);
        if (operation === 'create' || operation === 'update') {
            await store.saveKeyValue(dataDir, key, value);
            crudStats.create++;
        } else if (operation === 'delete') {
            await store.deleteKeyValue(dataDir, key);
            crudStats.delete++;
        }
        await fs.remove(tmp);
        logger.info(`[${selfId}] ✅ COMMIT ${operation} ${key}`);
        res.send({ status: 'ok' });
    } catch (err) {
        logger.error(`[${selfId}] ❌ COMMIT FAILED: ${err.message}`);
        res.status(500).send({ status: 'fail' });
    }
});

app.post('/internal/abort', jsonParser, async (req, res) => {
    const { key, operation } = req.body;
    try {
        const tmp = path.join(dataDir, `${md5(key)}.${operation}.prepare`);
        await fs.remove(tmp);
        logger.warn(`[${selfId}] 🛑 ABORT ${operation} ${key}`);
        res.send({ status: 'aborted' });
    } catch (err) {
        logger.error(`[${selfId}] ❌ ABORT FAILED: ${err.message}`);
        res.status(500).send({ status: 'fail' });
    }
});


async function twoPhaseCommit(followers, key, value, operation) {
    const prepare = await Promise.allSettled(
        followers.map(url => axios.post(`${url}/internal/prepare`, { key, value, operation }, { timeout: 1500 }))
    );
    const failed = prepare.filter(r => r.status !== 'fulfilled' || r.value.data.status !== 'ready');
    if (failed.length > 0) {
        await Promise.allSettled(
            followers.map(url => axios.post(`${url}/internal/abort`, { key, operation }, { timeout: 1000 }))
        );
        return false;
    }
    await Promise.all(
        followers.map(url => axios.post(`${url}/internal/commit`, { key, operation }, { timeout: 1500 }))
    );
    return true;
}

app.post('/internal/replicate', jsonParser, async (req, res) => {
    const { key, value } = req.body;
    try {
        await store.saveKeyValue(dataDir, key, value);
        crudStats.create++;
        logger.info(`[${selfId}] 📄 Key replication ${key}`);
        res.send({ status: 'ok' });
    } catch (err) {
        logger.error(`[${selfId}] ❌ Replication error: ${err.message}`);
        res.status(500).send({ status: 'error' });
    }
});

app.post('/internal/delete', jsonParser, async (req, res) => {
    const { key } = req.body;
    try {
        await store.deleteKeyValue(dataDir, key);
        crudStats.delete++;
        logger.info(`[${selfId}] 🧨 Delete replication ${key}`);
        res.send({ status: 'ok' });
    } catch (err) {
        logger.error(`[${selfId}] ❌ Error of replication delete: ${err.message}`);
        res.status(500).send({ status: 'error' });
    }
});

async function redirectIfNotLeader(req, res, next) {
    logger.info(`[${selfId}] 🧭 redirectIfNotLeader → state: ${raft.state}, leaderId: ${raft.leaderId}`);

    if (raft.state === 'leader') {
        logger.info(`[${selfId}] ✅ I am leader, going on`);
        return next();
    }

    if (!raft.leaderId) {
        logger.warn(`[${selfId}] ❌ No info about leader`);
        return res.status(503).send('❌ No info about leader');
    }

    const selfUrl = `http://localhost:${PORT}`;
    if (raft.leaderId === selfUrl) {
        logger.warn(`[${selfId}] ⚠️ I am not a leader but leader ID mentions me`);
        return next();
    }

    try {
        const leaderBase = raft.leaderId.replace(/\/$/, '');
        const targetUrl = leaderBase + req.originalUrl;
        logger.warn(`[${selfId}] 🔀 Redirect on leader: ${targetUrl}`);

        const result = await axios({
            method: req.method,
            url: targetUrl,
            data: req.body,
            headers: { ...req.headers, Connection: 'close' },
            validateStatus: () => true
        });

        res.status(result.status).set(result.headers).send(result.data);
    } catch (err) {
        logger.error(`[${selfId}] ❌ Failure of redirect: ${err.message}`);
        res.status(502).send('Failure in redirect');
    }
}

app.post('/key', redirectIfNotLeader, jsonParser, async (req, res) => {
    const { key, value } = req.body;
    logger.info(`[${selfId}] 🔥 POST /key: ${JSON.stringify(req.body)}`);
    if (!key || value === undefined) return res.status(400).send('❌ Нужны key и value');

    const nodeId = raft.getNodeId();
    const node = require('../../configuration.json').nodes.find(n => n.id === nodeId);
    const myUrl = `http://localhost:${PORT}`;
    const followers = node.servers.map(s => `http://localhost:${s.port}`).filter(url => url !== myUrl);

    const success = await twoPhaseCommit(followers, key, value, 'create');
    if (!success) {
        return res.status(409).json({
            resp: {
                error: {
                    code: 'ePREPFAIL', errno: 409, message: 'prepare phase failed'
                },
                data: 0
            }
        });
    }

    await store.saveKeyValue(dataDir, key, value);
    crudStats.create++;
    logger.info(`[${selfId}] ✅ Leader saved the key ${key}`);

    res.json({
        resp: {
            error: 0,
            data: {
                message: 'Saved and replicated',
                key,
                node: nodeId
            }
        }
    });
});

app.get('/key/:key', async (req, res) => {
    const key = req.params.key;

    try {
        const exists = await store.keyExists(dataDir, key);
        if (!exists) {
            return res.status(404).json({ error: 0, data: '❌ Key is not found' });
        }

        const data = await store.readKeyValue(dataDir, key);
        crudStats.read++;
        if (!data || typeof data !== 'object' || !data.key || !data.value) {
            logger.error(`[${selfId}] ❌ Invalid format ${key}`);
            return res.status(500).json({ error: 1, message: 'Invalid JSON' });
        }

        res.json(data);
    } catch (err) {
        logger.error(`[${selfId}] ❌ Failure in reading key: ${err.message}`);
        res.status(500).json({ error: 1, message: err.message });
    }
});

app.delete('/key/:key', redirectIfNotLeader, async (req, res) => {
    const key = req.params.key;

    const nodeId = raft.getNodeId();
    const node = require('../../configuration.json').nodes.find(n => n.id === nodeId);
    const myUrl = `http://localhost:${PORT}`;
    const followers = node.servers.map(s => `http://localhost:${s.port}`).filter(url => url !== myUrl);

    const success = await twoPhaseCommit(followers, key, null, 'delete');
    if (!success) {
        return res.status(409).json({
            resp: {
                error: {
                    code: 'eDELFAIL', errno: 409, message: 'prepare phase failed'
                },
                data: 0
            }
        });
    }

    await store.deleteKeyValue(dataDir, key);
    crudStats.delete++;
    logger.info(`[${selfId}] 🗑 Leader deleted the key: ${key}`);

    res.json({
        resp: {
            error: 0,
            data: {
                message: 'Deleted and replicated',
                key,
                node: nodeId
            }
        }
    });
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
    logger.info(`[${selfId}] ⛔ Received the stop signal`);
    isShuttingDown = true;
    res.send('Start of stop');
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