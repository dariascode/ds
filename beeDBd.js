const { Command } = require('commander');
const axios = require('axios');
const { exec } = require('child_process');
const pkg = require('./package.json');

const RP_URL = 'http://localhost:8000';
const RP_SCRIPT = 'src/reverse-proxy/reverse-proxy.js';
const STARTUP_WAIT_MS = 2000;

const cli = new Command();
cli.version(pkg.version);

cli
    .command('start')
    .description('Start RP and DN')
    .action(() => {
        console.log('➡️  Start with forever...');
        exec(`npx cross-env RP_ID=rp forever start ${RP_SCRIPT}`, err => {
            if (err) {
                console.error('❌ PR is failed: ', err.message);
                process.exit(1);
            }
            console.log(`✅ RP is started, wait for:  ${STARTUP_WAIT_MS / 1000}s `);
            setTimeout(async () => {
                try {
                    const r = await axios.get(`${RP_URL}/admin/start`);
                    console.log('✅', r.data.data.message);
                } catch (e) {
                    const info = e.response ? JSON.stringify(e.response.data) : e.message;
                    console.error('❌ Error of starting: ', info);
                    process.exit(1);
                }
            }, STARTUP_WAIT_MS);
        });
    });


cli
    .command('stop')
    .description('Stop RP and DN')
    .action(async () => {
        try {
            const r = await axios.get(`${RP_URL}/admin/stop`);
            console.log('✅', r.data.data.message);
        } catch (e) {
            const info = e.response ? JSON.stringify(e.response.data) : e.message;
            console.error('❌ Error of stop DN', info);
        } finally {
            console.log('➡️  Stop RP');
            exec(`npx forever stop ${RP_SCRIPT}`, err => {
                if (err) {
                    console.error('❌ RP не остановлен:', err.message);
                    process.exit(1);
                }
                console.log('✅ RP is stopped');
            });
        }
    });

// Команда restart: stop + пауза + start
cli
    .command('restart')
    .description('Restart RP and DN')
    .action(async () => {
        await cli.parseAsync(['node', 'beeDBd.js', 'stop']);
        await new Promise(r => setTimeout(r, 1000));
        await cli.parseAsync(['node', 'beeDBd.js', 'start']);
    });

// Команда status: статус DN через RP
cli
    .command('status')
    .description('Status of nodes')
    .action(async () => {
        try {
            const r = await axios.get(`${RP_URL}/admin/status`);
            const data = r.data?.resp?.data || r.data?.data;
            for (const nodeId in data) {
                console.log(`\n📦 Узел ${nodeId}:`);
                console.table(data[nodeId]);
            }
        } catch (e) {
            console.error('❌ Failed to get status: ', e.message);
            process.exit(1);
        }
    });


// Команда stats: статистика DB через RP
cli
    .command('stats')
    .description('Stats of nodes')
    .action(async () => {
        try {
            const r = await axios.get(`${RP_URL}/stats`);
            console.dir(r.data.data, { depth: null });
        } catch (e) {
            console.error('❌ Failed to get stats', e.message);
            process.exit(1);
        }
    });

cli.parse(process.argv);
