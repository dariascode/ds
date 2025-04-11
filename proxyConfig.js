// proxyConfig.js
module.exports = {
    nodes: {
        nodeA: [
            'http://localhost:3001',
            'http://localhost:3002',
            'http://localhost:3003',
            'http://localhost:3004'
        ],
        nodeB: [
            'http://localhost:4001',
            'http://localhost:4002',
            'http://localhost:4003',
            'http://localhost:4004'
        ],
        nodeC: [
            'http://localhost:5001',
            'http://localhost:5002',
            'http://localhost:5003',
            'http://localhost:5004'
        ]
    }
};
