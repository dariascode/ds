// raft.js
const axios = require('axios');
const logger = require('./logger');

class RaftNode {
    constructor(config) {
        this.id = config.id;
        this.peers = config.peers;
        this.state = 'follower';
        this.currentTerm = 0;
        this.votedFor = null;
        this.votesReceived = 0;

        this.electionTimeout = null;
        this.heartbeatInterval = null;

        this.startElectionTimer();
    }

    startElectionTimer() {
        const timeout = 150 + Math.random() * 150; // 150–300ms
        clearTimeout(this.electionTimeout);
        this.electionTimeout = setTimeout(() => this.startElection(), timeout);
    }

    async startElection() {
        this.state = 'candidate';
        this.currentTerm++;
        this.votedFor = this.id;
        this.votesReceived = 1;

        logger.info(`[${this.id}] 🗳 Start vote (term ${this.currentTerm})`);

        const voteRequest = {
            term: this.currentTerm,
            candidateId: this.id
        };

        for (const peer of this.peers) {
            try {
                const res = await axios.post(`${peer}/raft/vote`, voteRequest);
                if (res.data.voteGranted) {
                    this.votesReceived++;
                    logger.info(`[${this.id}] ✅ Recieved vote from ${peer}`);
                }
            } catch {
                logger.warn(`[${this.id}] ⚠️ No answer from ${peer}`);
            }
        }

        const majority = Math.floor(this.peers.length / 2) + 1;
        if (this.votesReceived >= majority) {
            this.becomeLeader();
        } else {
            logger.info(`[${this.id}] ❌ Dont have ehough votes, I am not a candidate`);
            this.startElectionTimer(); // снова подождём и попробуем
        }
    }

    becomeLeader() {
        this.state = 'leader';
        logger.info(`[${this.id}] 👑 I am leader (term ${this.currentTerm})`);
        this.sendHeartbeats();
        this.heartbeatInterval = setInterval(() => this.sendHeartbeats(), 100);
    }

    async sendHeartbeats() {
        for (const peer of this.peers) {
            try {
                await axios.post(`${peer}/raft/heartbeat`, {
                    term: this.currentTerm,
                    leaderId: this.id
                });
            } catch {
                logger.warn(`[${this.id}] ⚠️ Cannot send heartbeat → ${peer}`);
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
            this.startElectionTimer();
            voteGranted = true;
            logger.info(`[${this.id}] 🤝 Vote for ${candidateId} (term ${term})`);
        }

        res.json({ voteGranted });
    }

    handleHeartbeat(req, res) {
        const { term, leaderId } = req.body;
        if (term >= this.currentTerm) {
            this.currentTerm = term;
            this.votedFor = null;
            this.state = 'follower';
            this.startElectionTimer();
            logger.info(`[${this.id}] ❤️ Recieved heartbeat from ${leaderId} (term ${term})`);
        }
        res.sendStatus(200);
    }
}

module.exports = RaftNode;
