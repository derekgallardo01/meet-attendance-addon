const app = require('./src/app');
const CONFIG = require('./src/config');
const log = require('./src/lib/logger');

app.listen(CONFIG.port, () => log.info('server started', { port: CONFIG.port }));
