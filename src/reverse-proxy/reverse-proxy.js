const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const { exec } = require('child_process');
const logger = require('../logger/logger');
const rootCfg = require('../../configuration.json');

const app = express();
const PORT = 8000;
let isShuttingDown = false;
const rr = {};
const leaders = {}; // для хранения лидеров по node
for (const node of rootCfg.nodes) rr[node.id] = 0;

app.use(express.json());

app.use((req, res, next) => {
    if (isShuttingDown) {
        return res.status(503).json({
            resp: {
                error: { code: 'eRPMD023W', errno: 23, message: 'Система выключается' },
                data: 0
            }
        });
    }
    next();
});

// Получение node id из ключа
function getNodeByKey(key) {
    const hash = crypto.createHash('md5').update(key).digest('hex');
    const idx = parseInt(hash.slice(0, 8), 16) % rootCfg.nodes.length;
    return rootCfg.nodes[idx].id;
}

// Маршрут для регистрации лидера
app.get('/set_master', (req, res) => {
    const { node_id, leader_url } = req.query;
    if (!node_id || !leader_url) {
        return res.status(400).json({
            resp: {
                error: { code: 'eRPMD026E', errno: 26, message: 'Нужны node_id и leader_url' },
                data: 0
            }
        });
    }
    leaders[node_id] = leader_url;
    logger.info(`👑 Принят лидер: ${node_id} → ${leader_url}`);
    res.json({ resp: { error: 0, data: 'Лидер зарегистрирован' } });
});

// Прокси-запрос с умной маршрутизацией на лидера
async function proxyKeyRequest(req, res) {
    const key = req.body?.key || req.params?.key;
    if (!key) {
        return res.status(400).json({
            resp: {
                error: { code: 'eRPMD024W', errno: 24, message: 'Нужен ключ' },
                data: 0
            }
        });
    }

    const nodeId = getNodeByKey(key);
    const node = rootCfg.nodes.find(n => n.id === nodeId);
    const leaderUrl = leaders[nodeId];
    const targets = node.servers.map(s => `http://localhost:${s.port}`);
    const i = rr[nodeId];
    const fallback = targets[i];
    rr[nodeId] = (i + 1) % targets.length;

    const target = leaderUrl || fallback;

    let method = req.method;
    let url;
    let data = req.body;

    if (req.originalUrl.startsWith('/db/c')) {
        url = `${target}/key`;
    } else if (req.originalUrl.startsWith('/db/r')) {
        url = `${target}/key/${req.params.key}`;
        method = 'get';
        data = null;
    } else if (req.originalUrl.startsWith('/db/u')) {
        url = `${target}/key`;
    } else if (req.originalUrl.startsWith('/db/d')) {
        url = `${target}/key/${req.params.key}`;
        method = 'delete';
        data = null;
    }

    try {
        logger.info(`📡 proxy → ${method} ${url} — key=${key}`);

        const result = await axios({
            method,
            url,
            data,
            headers: req.headers,
            maxRedirects: 0,
            validateStatus: () => true
        });

        res.status(result.status).json({
            resp: {
                error: 0,
                data: result.data || {}
            }
        });

    } catch (err) {
        if (err.response) {
            logger.error(`❌ Ответ с ошибкой от DN: ${JSON.stringify(err.response.data)}`);
        } else if (err.request) {
            logger.error(`❌ DN не отвечает: ${err.message}`);
        } else {
            logger.error(`❌ Сбой RP: ${err.message}`);
        }

        res.status(502).json({
            resp: {
                error: {
                    code: 'eRPMD025E',
                    errno: 25,
                    message: err.message || 'Unknown proxy error'
                },
                data: 0
            }
        });
    }
}

app.post('/db/c', proxyKeyRequest);
app.get('/db/r/:key', proxyKeyRequest);
app.post('/db/u', proxyKeyRequest);
app.get('/db/d/:key', proxyKeyRequest);

app.get('/admin/status', async (req, res) => {
    const report = {};
    for (const node of rootCfg.nodes) {
        report[node.id] = [];
        for (const srv of node.servers) {
            const url = `http://localhost:${srv.port}/key/ping`;
            try {
                await axios.get(url);
                report[node.id].push({ port: srv.port, status: 'OK' });
            } catch {
                report[node.id].push({ port: srv.port, status: 'DOWN' });
            }
        }
    }
    res.json({ resp: { error: 0, data: report } });
});

app.get('/stats', (req, res) => {
    res.json({ resp: { error: 0, data: { stats: 'not implemented' } } });
});

async function startDN() {
    console.log('➡️  Запуск DN-процессов...');
    const baseDir = process.cwd();
    for (const node of rootCfg.nodes) {
        for (const srv of node.servers) {
            const srvScript = path.relative(baseDir, path.join(__dirname, '..', 'server', 'server.js'));
            const cfgFile = path.resolve(baseDir, node.configDirBase, `${srv.id}.json`);
            const cmd = `npx forever start "${srvScript}" "${cfgFile}"`;
            console.log(`🔧 CMD [${srv.id}]: ${cmd}`);
            await new Promise(resolve => {
                exec(cmd, (err, stdout, stderr) => {
                    if (stdout) console.log(`📢 [${srv.id}] stdout:\n${stdout}`);
                    if (stderr) console.error(`⚠️ [${srv.id}] stderr:\n${stderr}`);
                    if (err) console.error(`❌ [${srv.id}] Ошибка запуска:`, err.message);
                    else console.log(`✅ [${srv.id}] успешно запущен`);
                    resolve();
                });
            });
            await new Promise(r => setTimeout(r, 300));
        }
    }
    console.log('✅ Все DN-процессы запущены.');
}

function stopDN() {
    console.log('➡️  Остановка DN...');
    exec('npx forever stopall', (err, stdout, stderr) => {
        if (stdout) console.log(`📢 stopall stdout:\n${stdout}`);
        if (stderr) console.error(`⚠️ stopall stderr:\n${stderr}`);
        if (err) console.error('❌ Ошибка остановки DN:', err.message);
        else console.log('✅ DN-процессы остановлены');
    });
}

app.get('/admin/start', async (req, res) => {
    try {
        await startDN();
        res.json({ resp: { error: 0, data: { message: 'Запуск DN инициирован' } } });
    } catch (e) {
        res.status(500).json({
            resp: {
                error: { code: 'eRPMD100E', errno: 100, message: e.message },
                data: 0
            }
        });
    }
});

app.get('/admin/stop', async (req, res) => {
    isShuttingDown = true;
    try {
        await stopDN();
        res.json({ resp: { error: 0, data: { message: 'Остановка DN инициирована' } } });
    } catch (e) {
        res.status(500).json({
            resp: {
                error: { code: 'eRPMD101E', errno: 101, message: e.message },
                data: 0
            }
        });
    }
});

app.listen(PORT, () => {
    logger.info(`🌐 Reverse Proxy запущен на порту ${PORT}`);
});
