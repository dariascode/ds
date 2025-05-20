const axios = require('axios');
const logger = require('../logger/logger');
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

        this.startElectionTimer();
    }

    startElectionTimer() {
        const timeout = 300 + Math.random() * 400; // от 300 до 700 мс
        clearTimeout(this.electionTimeout);
        this.electionTimeout = setTimeout(() => this.startElection(), timeout);
    }

    async startElection() {
        this.state = 'candidate';
        this.currentTerm++;
        this.votedFor = this.id;
        this.votesReceived = 1;
        this.leaderId = null;

        logger.info(`[${this.id}] 🗳 Старт выборов (term ${this.currentTerm})`);

        const voteRequest = {
            term: this.currentTerm,
            candidateId: this.id
        };

        for (const peer of this.peers) {
            try {
                const res = await axios.post(`${peer}/raft/vote`, voteRequest);
                if (res.data.voteGranted) {
                    this.votesReceived++;
                    logger.info(`[${this.id}] ✅ Голос от ${peer}`);
                }
            } catch {
                logger.warn(`[${this.id}] ⚠️ Нет ответа от ${peer}`);
            }
        }

        const majority = Math.floor(this.peers.length / 2) + 1;
        if (this.votesReceived >= majority) {
            this.becomeLeader();
        } else {
            logger.info(`[${this.id}] ❌ Недостаточно голосов, остаюсь follower`);
            this.startElectionTimer();
        }
    }

    becomeLeader() {
        this.state = 'leader';
        this.leaderId = `http://localhost:${this.port}`;
        console.log(`[${this.id}] 👑 Я стал лидером (term ${this.currentTerm})`);

        axios.get('http://localhost:8000/set_master', {
            params: {
                node_id: this.getNodeId(),
                leader_url: this.leaderId
            }
        }).then(() => {
            console.log(`[${this.id}] ✅ RP уведомлён: ${this.getNodeId()} → ${this.leaderId}`);
        }).catch((err) => {
            console.error(`[${this.id}] ❌ Ошибка уведомления RP: ${err.message}`);
        });

        this.sendHeartbeats();
        this.heartbeatInterval = setInterval(() => this.sendHeartbeats(), 100);
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
                await axios.post(`${peer}/raft/heartbeat`, {
                    term: this.currentTerm,
                    leaderId: this.leaderId
                });
            } catch {
                logger.warn(`[${this.id}] ⚠️ Heartbeat не отправлен → ${peer}`);
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
            this.startElectionTimer();
            voteGranted = true;
            logger.info(`[${this.id}] 🤝 Голос за ${candidateId} (term ${term})`);
        }

        res.json({ voteGranted });
    }

    handleHeartbeat(req, res) {
        const { term, leaderId } = req.body;
        if (term >= this.currentTerm) {
            this.currentTerm = term;
            this.votedFor = null;
            this.state = 'follower';
            this.leaderId = leaderId || null;
            this.startElectionTimer();
            logger.info(`[${this.id}] ❤️ Heartbeat от ${leaderId} (term ${term})`);
        }
        res.sendStatus(200);
    }
}

module.exports = RaftNode;