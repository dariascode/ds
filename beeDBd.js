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
                console.error('❌ RP failed to start: ', err.message);
                process.exit(1);
            }
            console.log(`✅ RP is started, wait for: ${STARTUP_WAIT_MS / 1000}s`);
            setTimeout(async () => {
                try {
                    const r = await axios.get(`${RP_URL}/admin/start`);
                    const message = r?.data?.data?.message || '[No message returned]';
                    console.log('✅', message);
                } catch (e) {
                    let info;
                    if (e.response && e.response.data) {
                        try {
                            info = typeof e.response.data === 'string'
                                ? e.response.data
                                : JSON.stringify(e.response.data, null, 2);
                        } catch (err) {
                            info = '[Cannot stringify response data]';
                        }
                    } else {
                        info = e.message || 'Unknown error';
                    }
                    console.error('❌ Error of starting:', info);
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
            const message = r?.data?.data?.message || '[No message returned]';
            console.log('✅', message);
        } catch (e) {
            let info;
            if (e.response && e.response.data) {
                try {
                    info = typeof e.response.data === 'string'
                        ? e.response.data
                        : JSON.stringify(e.response.data, null, 2);
                } catch (err) {
                    info = '[Cannot stringify response data]';
                }
            } else {
                info = e.message || 'Unknown error';
            }
            console.error('❌ Error of stop DN:', info);
        } finally {
            console.log('➡️  Stop RP');
            exec(`npx forever stop ${RP_SCRIPT}`, err => {
                if (err) {
                    console.error('❌ RP is not stopped:', err.message);
                    process.exit(1);
                }
                console.log('✅ RP is stopped');
            });
        }
    });



cli
    .command('restart')
    .description('Restart RP and DN')
    .action(async () => {
        await cli.parseAsync(['node', 'beeDBd.js', 'stop']);
        await new Promise(r => setTimeout(r, 1000));
        await cli.parseAsync(['node', 'beeDBd.js', 'start']);
    });


cli
    .command('status')
    .description('Status of nodes')
    .action(async () => {
        try {
            const r = await axios.get(`${RP_URL}/admin/status`);
            const data = r.data?.resp?.data || r.data?.data;
            for (const nodeId in data) {
                console.log(`\n📦 Node ${nodeId}:`);
                console.table(data[nodeId]);
            }
        } catch (e) {
            console.error('❌ Failed to get status: ', e.message);
            process.exit(1);
        }
    });

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