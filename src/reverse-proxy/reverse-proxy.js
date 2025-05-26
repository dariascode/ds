// reverse-proxy.js (fixed headers + timeout)
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const { exec } = require('child_process');
const createLogger = require('../logger/logger');
const rootCfg = require('../../configuration.json');
const jsonParser = express.json();


process.env.RP_ID = 'rp';
const logger = createLogger({ type: 'rp' });

const app = express();
const PORT = 8000;
let isShuttingDown = false;
const rr = {};
const leaders = {};
for (const node of rootCfg.nodes) rr[node.id] = 0;

app.post('/db/c', jsonParser, proxyKeyRequest);
app.post('/db/u', jsonParser, proxyKeyRequest);
app.get('/db/r/:key', proxyKeyRequest);
app.get('/db/d/:key', proxyKeyRequest);


app.use((req, res, next) => {
    if (req.method === 'GET') {
        req.body = {};
    }
    next();
});



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

function getNodeByKey(key) {
    const hash = crypto.createHash('md5').update(key).digest('hex');
    const idx = parseInt(hash.slice(0, 8), 16) % rootCfg.nodes.length;
    return rootCfg.nodes[idx].id;
}

app.get('/set_master', (req, res) => {
    const { node_id, leader_url } = req.query;
    if (!node_id || !leader_url) {
        return res.status(400).json({
            resp: {
                error: { code: 'eRPMD026E', errno: 26, message: 'Need node_id and leader_url' },
                data: 0
            }
        });
    }
    leaders[node_id] = leader_url;
    logger.info(`👑 Received leader: ${node_id} → ${leader_url}`);
    res.json({ resp: { error: 0, data: 'Leader registered' } });
});

async function proxyKeyRequest(req, res) {
    const key = req.body?.key || req.params?.key;
    if (!key) {
        return res.status(400).json({
            resp: {
                error: { code: 'eRPMD024W', errno: 24, message: 'Need key' },
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
            headers: {
                'Content-Type': req.headers['content-type'] || 'application/json'
            },
            timeout: 2000,
            maxRedirects: 0,
            validateStatus: () => true
        });

        const isJson =
            result.headers['content-type'] &&
            result.headers['content-type'].includes('application/json');

        if (isJson && typeof result.data === 'object') {
            res.status(result.status).json({
                resp: { error: 0, data: result.data }
            });
        } else {
            res.status(result.status).json({
                resp: { error: 0, data: { raw: result.data } }
            });
        }
    } catch (err) {
        if (err.response) {
            logger.error(`❌ Res with error from DN: ${JSON.stringify(err.response.data)}`);
        } else if (err.request) {
            logger.error(`❌ DN does not respond:  ${err.message}`);
        } else {
            logger.error(`❌ RP failure:  ${err.message}`);
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

app.get('/stats', async (req, res) => {
    try {
        const config = require('../../configuration.json');
        const nodes = config.nodes;
        const result = {};

        for (const node of nodes) {
            const nodeStats = [];

            for (const server of node.servers) {
                const url = `http://localhost:${server.port}/stats`;
                try {
                    const response = await axios.get(url, { timeout: 1000 });
                    nodeStats.push({
                        id: response.data.id,
                        stats: response.data.stats
                    });
                } catch (err) {
                    nodeStats.push({
                        id: server.id,
                        error: '❌ unavailable'
                    });
                }
            }

            result[node.id] = nodeStats;
        }

        res.json({ data: result });
    } catch (err) {
        res.status(500).json({
            error: '❌ Error stats',
            message: err.message
        });
    }
});


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
    console.log('➡️  Start DNs');
    const baseDir = process.cwd();
    for (const node of rootCfg.nodes) {
        for (const srv of node.servers) {
            const srvScript = path.relative(baseDir, path.join(__dirname, '..', 'server', 'server.js'));
            const cfgFile = path.resolve(baseDir, node.configDirBase, `${srv.id}.json`);
            const cmd = `npx cross-env SERVER_ID=${srv.id} forever start "${srvScript}" "${cfgFile}"`;
            console.log(`🔧 CMD [${srv.id}]: ${cmd}`);
            await new Promise(resolve => {
                exec(cmd, (err, stdout, stderr) => {
                    if (stdout) console.log(`📢 [${srv.id}] stdout:\n${stdout}`);
                    if (stderr) console.error(`⚠️ [${srv.id}] stderr:\n${stderr}`);
                    if (err) console.error(`❌ [${srv.id}] Error starting: `, err.message);
                    else console.log(`✅ [${srv.id}] succesfully started`);
                    resolve();
                });
            });
            await new Promise(r => setTimeout(r, 300));
        }
    }
    console.log('✅ All DNs running');
}

function stopDN() {
    console.log('➡️  Stop DNs');
    exec('npx forever stopall', (err, stdout, stderr) => {
        if (stdout) console.log(`📢 stopall stdout:\n${stdout}`);
        if (stderr) console.error(`⚠️ stopall stderr:\n${stderr}`);
        if (err) console.error('❌ Error stop DNs', err.message);
        else console.log('✅ DNs stopped');
    });
}

app.get('/admin/start', async (req, res) => {
    try {
        await startDN();
        res.json({ resp: { error: 0, data: { message: 'Start DN initiated' } } });
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
        res.json({ resp: { error: 0, data: { message: 'Stop DN initiated' } } });
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
    logger.info(`🌐 Reverse Proxy is running on port ${PORT}`);
});
