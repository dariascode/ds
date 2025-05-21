const axios = require('axios');
const createLogger = require('../logger/logger');
const logger = createLogger({ type: 'raft' });
const rootCfg = require('../../configuration.json');

class RaftNode {
    constructor(config) {
        this.id = config.id;
        this.peers = config.peers;
        this.port = config.port;

        this.state = 'follower';
        this.currentTerm = 0;
        this.votedFor = null;
        this.votesReceived = 0;
        this.leaderId = null;

        this.electionTimeout = null;
        this.heartbeatInterval = null;
        this.unreachablePeers = new Set(); // <--- добавлено

        this.logRole('follower');
        this.startElectionTimer();
    }

    logRole(state) {
        const roleIcons = {
            follower: '👂',
            candidate: '🔁',
            leader:   '👑'
        };
        logger.info(`[${this.id}] ${roleIcons[state]} Роль: ${state.toUpperCase()} (term ${this.currentTerm})`);
    }

    startElectionTimer() {
        const timeout = 1000 + Math.random() * 500;
        clearTimeout(this.electionTimeout);
        this.electionTimeout = setTimeout(() => this.startElection(), timeout);
    }

    async startElection() {
        this.state = 'candidate';
        this.currentTerm++;
        this.votedFor = this.id;
        this.votesReceived = 1;
        this.leaderId = null;
        this.logRole('candidate');

        logger.info(`[${this.id}] 🗳 Старт выборов (term ${this.currentTerm})`);

        const voteRequest = {
            term: this.currentTerm,
            candidateId: this.id
        };

        for (const peer of this.peers) {
            try {
                const res = await axios.post(`${peer}/raft/vote`, voteRequest, {
                    timeout: 1500,
                    headers: { Connection: 'close' }
                });
                if (res.data.voteGranted) {
                    this.votesReceived++;
                    logger.info(`[${this.id}] ✅ Голос от ${peer}`);
                } else {
                    logger.debug(`[${this.id}] ❌ Отказ в голосе от ${peer}`);
                }
            } catch (err) {
                logger.warn(`[${this.id}] ⚠️ Нет ответа от ${peer}: ${err.message}`);
            }
        }

        const majority = Math.floor(this.peers.length / 2) + 1;
        if (this.votesReceived >= majority) {
            this.becomeLeader();
        } else {
            logger.info(`[${this.id}] ❌ Недостаточно голосов, остаюсь follower`);
            this.state = 'follower';
            this.logRole('follower');
            this.startElectionTimer();
        }
    }

    becomeLeader() {
        this.state = 'leader';
        this.leaderId = `http://localhost:${this.port}`;
        this.logRole('leader');

        axios.get('http://localhost:8000/set_master', {
            params: {
                node_id: this.getNodeId(),
                leader_url: this.leaderId
            }
        }).then(() => {
            logger.info(`[${this.id}] ✅ RP уведомлён: ${this.getNodeId()} → ${this.leaderId}`);
        }).catch((err) => {
            logger.error(`[${this.id}] ❌ Ошибка уведомления RP: ${err.message}`);
        });

        this.sendHeartbeats();
        this.heartbeatInterval = setInterval(() => this.sendHeartbeats(), 150);
    }

    getNodeId() {
        for (const node of rootCfg.nodes) {
            if (node.servers.find(s => s.id === this.id)) {
                return node.id;
            }
        }
        return 'unknown';
    }

    async sendHeartbeats() {
        for (const peer of this.peers) {
            try {
                const res = await axios.post(
                    `${peer}/raft/heartbeat`,
                    {
                        term: this.currentTerm,
                        leaderId: this.leaderId
                    },
                    {
                        timeout: 1500,
                        headers: { Connection: 'close' }
                    }
                );

                if (res.status === 200) {
                    if (this.unreachablePeers.has(peer)) {
                        this.unreachablePeers.delete(peer);
                        logger.info(`[${this.id}] 🔌 Восстановлено соединение с ${peer}`);
                    }
                    logger.debug(`[${this.id}] ❤️ Heartbeat принят → ${peer}`);
                } else {
                    logger.warn(`[${this.id}] ⚠️ Heartbeat ответ ${res.status} от ${peer}`);
                }
            } catch (err) {
                if (!this.unreachablePeers.has(peer)) {
                    this.unreachablePeers.add(peer);
                    logger.warn(`[${this.id}] 🚫 Потеряно соединение с ${peer}: ${err.message}`);
                }
            }
        }
    }

    handleVoteRequest(req, res) {
        const { term, candidateId } = req.body;
        let voteGranted = false;

        if (term >= this.currentTerm && this.votedFor === null) {
            this.votedFor = candidateId;
            this.currentTerm = term;
            this.state = 'follower';
            this.leaderId = null;
            this.logRole('follower');
            this.startElectionTimer();
            voteGranted = true;
            logger.info(`[${this.id}] 🤝 Голос за ${candidateId} (term ${term})`);
        }

        res.json({ voteGranted });
    }

    handleHeartbeat(req, res) {
        const { term, leaderId } = req.body;
        const becameFollower = this.state !== 'follower';

        if (term >= this.currentTerm) {
            this.currentTerm = term;
            this.votedFor = null;
            this.state = 'follower';
            this.leaderId = leaderId || null;
            if (becameFollower) this.logRole('follower');
            this.startElectionTimer();
            logger.info(`[${this.id}] ❤️ Heartbeat от ${leaderId} (term ${term})`);
        }

        res.status(200).json({ status: 'ok' });
    }
}

module.exports = RaftNode;
// small test