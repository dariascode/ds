// reverse-proxy.js
const express = require('express');
const httpProxy = require('http-proxy');
const axios = require('axios');
const logger = require('./logger');
const { nodes } = require('./proxyConfig');
const crypto = require('crypto');

const app = express();
const proxy = httpProxy.createProxyServer();
const PORT = 8000;

let isShuttingDown = false;

// Поддержка JSON тела запроса
app.use(express.json());

// Храним "указатель" на текущий сервер для round-robin внутри каждого узла
const roundRobinState = {};
for (const node in nodes) {
    roundRobinState[node] = 0;
}

// Middleware: блокируем новые запросы при остановке
app.use((req, res, next) => {
    if (isShuttingDown) {
        return res.status(503).send('⛔ Система выключается. Попробуйте позже.');
    }
    next();
});

// 🔢 Выбор узла по ключу (шардирование)
function getNodeByKey(key) {
    const hash = crypto.createHash('md5').update(key).digest('hex');
    const nodeIndex = parseInt(hash.slice(0, 8), 16) % Object.keys(nodes).length;
    const nodeNames = Object.keys(nodes);
    return nodeNames[nodeIndex]; // возвращает 'nodeA', 'nodeB', или 'nodeC'
}

// 🔁 Универсальный проксирующий обработчик
function proxyKeyRequest(req, res) {
    const key = req.body?.key || req.params?.key;
    if (!key) {
        return res.status(400).send('❌ Нужен key для маршрутизации');
    }

    const nodeName = getNodeByKey(key);
    const nodeList = nodes[nodeName];
    const i = roundRobinState[nodeName];
    const target = nodeList[i];

    roundRobinState[nodeName] = (i + 1) % nodeList.length;

    logger.info(`🔁 Ключ '${key}' → ${nodeName} → ${target}`);
    proxy.web(req, res, { target }, err => {
        logger.error(`❌ Ошибка проксирования: ${err.message}`);
        res.status(502).send('Прокси не смог передать запрос');
    });
}

// === API /key ===
app.post('/key', proxyKeyRequest);
app.get('/key/:key', proxyKeyRequest);
app.delete('/key/:key', proxyKeyRequest);

// === ADMIN ===

app.get('/admin/start', (req, res) => {
    logger.info('🚀 Запуск серверов вручную не реализован в JS (используйте shell-скрипт)');
    res.send('⚙️ Предполагается запуск через shell-скрипты');
});

app.get('/admin/stop', async (req, res) => {
    logger.info('🛑 Старт безопасной остановки всех серверов...');
    isShuttingDown = true;

    const shutdownPromises = [];
    for (const node in nodes) {
        for (const url of nodes[node]) {
            shutdownPromises.push(
                axios.get(`${url}/internal/shutdown`)
                    .then(() => logger.info(`⛔ ${url} — получил shutdown`))
                    .catch(err => logger.warn(`⚠️ ${url} — недоступен (${err.message})`))
            );
        }
    }

    await Promise.allSettled(shutdownPromises);
    res.send('🛑 Сигналы отправлены. Система завершает работу.');
});

app.get('/admin/status', async (req, res) => {
    const statusReport = {};

    for (const node in nodes) {
        statusReport[node] = [];
        for (const url of nodes[node]) {
            try {
                await axios.get(`${url}/key/ping`);
                statusReport[node].push({ url, status: '🟢 OK' });
            } catch {
                statusReport[node].push({ url, status: '🔴 Недоступен' });
            }
        }
    }

    res.json(statusReport);
});

app.listen(PORT, () => {
    logger.info(`🌐 Reverse Proxy запущен на порту ${PORT}`);
});
