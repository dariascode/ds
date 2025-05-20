#!/usr/bin/env node
// beeDBd.js — утилита для управления beeDB (RP + DN)

const { Command } = require('commander');
const axios = require('axios');
const { exec } = require('child_process');
const pkg = require('./package.json');

const RP_URL = 'http://localhost:8000';
const RP_SCRIPT = 'src/reverse-proxy/reverse-proxy.js';
const STARTUP_WAIT_MS = 2000;

const cli = new Command();
cli.version(pkg.version);

// Команда start: сначала RP, потом DN через RP
cli
    .command('start')
    .description('Запустить кластер (RP + DN)')
    .action(() => {
        console.log('➡️  Старт RP через forever...');
        exec(`npx cross-env RP_ID=rp forever start ${RP_SCRIPT}`, err => {
            if (err) {
                console.error('❌ RP не удалось запустить:', err.message);
                process.exit(1);
            }
            console.log(`✅ RP запущен, ждём ${STARTUP_WAIT_MS / 1000}s для инициализации...`);
            setTimeout(async () => {
                try {
                    const r = await axios.get(`${RP_URL}/admin/start`);
                    console.log('✅', r.data.data.message);
                } catch (e) {
                    const info = e.response ? JSON.stringify(e.response.data) : e.message;
                    console.error('❌ Ошибка старта DN:', info);
                    process.exit(1);
                }
            }, STARTUP_WAIT_MS);
        });
    });

// Команда stop: сначала DN, потом RP
cli
    .command('stop')
    .description('Остановить кластер (DN + RP)')
    .action(async () => {
        try {
            const r = await axios.get(`${RP_URL}/admin/stop`);
            console.log('✅', r.data.data.message);
        } catch (e) {
            const info = e.response ? JSON.stringify(e.response.data) : e.message;
            console.error('❌ Ошибка остановки DN:', info);
        } finally {
            console.log('➡️  Останавливаем RP...');
            exec(`npx forever stop ${RP_SCRIPT}`, err => {
                if (err) {
                    console.error('❌ RP не остановлен:', err.message);
                    process.exit(1);
                }
                console.log('✅ RP остановлен');
            });
        }
    });

// Команда restart: stop + пауза + start
cli
    .command('restart')
    .description('Перезапустить кластер')
    .action(async () => {
        await cli.parseAsync(['node', 'beeDBd.js', 'stop']);
        await new Promise(r => setTimeout(r, 1000));
        await cli.parseAsync(['node', 'beeDBd.js', 'start']);
    });

// Команда status: статус DN через RP
cli
    .command('status')
    .description('Показать статус DN')
    .action(async () => {
        try {
            const r = await axios.get(`${RP_URL}/admin/status`);
            console.dir(r.data.data, { depth: null });
        } catch (e) {
            console.error('❌ Не удалось получить статус:', e.message);
            process.exit(1);
        }
    });

// Команда stats: статистика DB через RP
cli
    .command('stats')
    .description('Показать статистику DB')
    .action(async () => {
        try {
            const r = await axios.get(`${RP_URL}/stats`);
            console.dir(r.data.data, { depth: null });
        } catch (e) {
            console.error('❌ Не удалось получить статистику:', e.message);
            process.exit(1);
        }
    });

cli.parse(process.argv);
