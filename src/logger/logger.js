const { createLogger, format, transports } = require('winston');
const path = require('path');
const fs = require('fs');

function createCustomLogger({ type = 'general' }) {
    const id = process.env.SERVER_ID || process.env.RP_ID || 'unknown';
    const logDir = path.join(__dirname, '..', 'logs', id);

    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    return createLogger({
        level: 'info',
        format: format.combine(
            format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            format.printf(({ timestamp, level, message }) =>
                `[${timestamp}] ${level.toUpperCase()}: ${message}`
            )
        ),
        transports: [
            new transports.Console(),
            new transports.File({ filename: path.join(logDir, `${type}.log`) })
        ],
    });
}

module.exports = createCustomLogger;
