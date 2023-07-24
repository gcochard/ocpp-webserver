const process = require('node:process');
const config = require('./config.json');
const fs = require('fs');
const { port, charger_name, loglevel = 'debug' } = config;
const loglevels = {
    silly: 0,
    debug: 1,
    info: 2,
    warn: 3,
    err: 4,
    fatal: 5
};
const moment = require('moment');
const { EventEmitter } = require('node:events');
const clients = new Map();

function createLogger(level) {
    if(!Object.hasOwn(loglevels, level)){
        throw new Error(`Loglevel ${level} does not exist`);
    }
    const logger = loglevels[level] >= 3 ? console.error : console.log;
    if(loglevels[level] < loglevels[loglevel]){
        return function(){};
    }
    return function(){
        var first_parameter = arguments[0];
        var other_parameters = Array.prototype.slice.call(arguments, 1);

        if(other_parameters.length){
            logger.apply(console, [`[${moment().format()}] [${level}] ` + first_parameter].concat(other_parameters));
        } else {
            logger.apply(console, [`[${moment().format()}] [${level}]`, first_parameter]);
        }
    };
}

const log = {
    silly: createLogger('silly'),
    debug: createLogger('debug'),
    info: createLogger('info'),
    warn: createLogger('warn'),
    warning: createLogger('warn'),
    err: createLogger('err'),
    error: createLogger('err'),
    fatal: createLogger('fatal')
};

function calculateStartTime(){
    const now = moment();
    const startTime = moment();
    // according to https://github.com/lbbrhzn/ocpp/issues/442#issuecomment-1544805046
    // we need to delay the start *at least* 1 second before sending RemoteStartTransaction after Preparing
    // this should be fine to add 10 seconds
    now.add(10, 'seconds');
    startTime.add(10, 'seconds');
    const dayOfWeek = now.day();
    log.debug(`day of week: ${dayOfWeek}`);
    if(dayOfWeek == 0 || dayOfWeek == 6 || dayOfWeek == 7){
        log.silly(`weekend`);
        log.debug(`now: ${now.format()}`);
        // this is the weekend
        if(now.hour() < 14){
            log.info(`not yet 2:00pm`,);
            // start it!
        } else {
            log.info(`past 2:00pm, deferring until tomorrow`);
            // set it to midnight
            startTime.hour(0).minute(0).second(0).add(1, 'day');
        }
    } else {
        // this is a weekday
        log.silly(`weekday`);
        log.debug(`now: ${now.format()}`);
        if(now.hour() < 6){
            log.info(`not yet 6:00am`,);
            // start it!
        } else {
            // set it to midnight
            log.info(`past 6:00am, deferring until tomorrow`);
            startTime.hour(0).minute(0).second(0).add(1, 'day');
        }
    }
    return startTime;
}

let stateWritten = false;
function exitHandler(eventName){
    log.info(`exitHandler registered for ${eventName}`);
    return (code) => {
        const state = {};
        if(!stateWritten){
            log.info('shutting down, dumping state');
            for (const client of clients.values()) {
                const {
                    status, statusNotifications, startTime,
                    endTime, transactions, transactionId,
                    lastTransaction, lastTransactionId, sessionId
                } = client.session;
                state[sessionId] = {
                    status, statusNotifications, startTime,
                    endTime, transactions, transactionId,
                    lastTransaction, lastTransactionId, sessionId
                };
            }
            fs.writeFileSync('./state.json', JSON.stringify(state));
            stateWritten = true;
        }
        if(code == 'SIGINT'){
            process.exit();
        }
    };
}
// ctrl+c doesn't trigger the `exit` event, so we have to handle it in SIGINT
process.on('exit', exitHandler('exit'));
process.on('SIGINT', exitHandler('SIGINT'));
let state = {};
try {
    state = require('./state.json');
    for(const client of Object.values(state)){
        log.debug(`loading state for client: ${client.sessionId}`);
        clients.set(client.sessionId, {session: {...client}});
    }
} catch(e){
    log.debug('no state, not restoring it');
}

/**
 * Taken from https://stackoverflow.com/a/54431931/1355166
 * Emit all events on '*' and then re-emit
 */
class GlobEmitter extends EventEmitter {
    emit(type, ...args) {
        super.emit('*', [type, ...args]);
        return super.emit(type, ...args) || super.emit('', ...args);
    }
}
(async function(){
    const { RPCServer, createRPCError } = require('ocpp-rpc');
    const express = require('express');
    const app = express();
    const httpServer = app.listen(port, '0.0.0.0');
    const util = require('util');
    const ee = new GlobEmitter();
    const evtStream = fs.createWriteStream('./eventlog.log', {flags: 'a'});
    ee.on('*', args => {
        let sargs = '';
        try {
            sargs = JSON.stringify(args);
        } catch(e){
            sargs = util.inspect(args, {depth: 8});
        }
        evtStream.write(`${sargs}\n`);
    });

    app.use((req, res, next) => {
        next();
        console.log(`${req.ip} - - [${moment().toDate().toUTCString()}] "${req.method} ${req.path} HTTP/${req.httpVersion}" ${res.statusCode} ${res.get('content-length')}`);
    });
    app.get('/clients', (req, res) => {
        return res.json(Array.from(clients.keys()));
    });
    app.get('/clients/:client', (req, res) => {
        if(!clients.has(req.params.client)){
            return res.status(503).send('Client not connected');
        }
        const { client } = req.params;
        log.debug('abridging transactions for status');
        // this is a shallow clone, we can't mutate the meterValues array here
        const clone = {...clients.get(client).session};
        // we can't structuredClone something with functions, so we have to delete those
        delete clone.startTimeout;
        delete clone.endTimeout;
        const abridgedSess = structuredClone(clone);
        // if there's more than one transaction, take the last one
        for(const txId in abridgedSess.transactions){
            const tx = abridgedSess.transactions[txId];
            log.debug(`checking ${txId}: tx.meterValues.length: ${tx.meterValues.length}`);
            if(tx.meterValues.length > 100){
                log.debug(`abridging transaction ${txId}`);
                // take the first 75 and last 25
                abridgedSess.transactions[txId].meterValues = [...tx.meterValues.slice(0, 75), ...tx.meterValues.slice(-25)];
            }
        }
        const sess = util.inspect(abridgedSess, {compact: false, depth: 8});
        res.send(
`<!DOCTYPE html>
<html>
  <head>
    <title>${client} status</title>
  </head>
  <body>
    <div>
      <form method="post">
        <ul>
          <li><button formaction="/clients/${client}/trigger/BootNotification">Trigger BootNotification</button></li>
          <li><button formaction="/clients/${client}/trigger/StatusNotification">Trigger StatusNotification</button></li>
          <li><button formaction="/clients/${client}/trigger/Heartbeat">Trigger Heartbeat</button></li>
          <li><button formaction="/clients/${client}/trigger/MeterValues">Trigger MeterValues</button></li>
        </ul>
        <ul>
          <li><button formaction="/clients/${client}/start">Start charge session</button></li>
          <li><button formaction="/clients/${client}/stop">Stop charge session</button></li>
          <li><button formaction="/clients/${client}/softreset">Soft reset charger</button></li>
        </ul>
      </form>
    </div>
    <div>
      <pre>${sess}</pre>
    </div>
  </body>
</html>
`);
    });

    app.get('/clients/:client/config', async (req, res) => {
        if(!clients.has(req.params.client)){
            return res.status(503).send('Client not connected');
        }
        const response = await clients.get(req.params.client).call('GetConfiguration', { });
        log.debug(response);
        res.json(response);
    });

    app.post('/clients/:client/trigger/:msg', async (req, res) => {
        if(!clients.has(req.params.client)){
            return res.status(503).send('Client not connected');
        }
        client = clients.get(req.params.client);
        if(['StatusNotification', 'BootNotification', 'Heartbeat', 'MeterValues'].indexOf(req.params.msg) === -1){
            return res.status(400).send('invalid message');
        }
        if(req.params.msg == 'MeterValues' && Object.keys(client.session).indexOf('transactionId') === -1){
            return res.status(400).send('No transaction in progress, no meter values will be sent');
        }
        let sent = false;
        const timeout = setTimeout(() => {
            if(!sent){
                sent = true;
                res.status(503).send('Timeout while waiting for response');
                ee.off(`${req.params.client}:${req.params.msg}`, listener);
            }
        }, 30000);
        const listener = resp => {
            if(!sent){
                sent = true;
                res.json(resp);
                clearTimeout(timeout);
            }
        };
        ee.once(`${req.params.client}:${req.params.msg}`, listener);
        const response = await client.safeCall('TriggerMessage', { requestedMessage: req.params.msg});
        log.debug(response);
        //res.json(response);
    });

    app.post('/clients/:client/softreset', async (req, res) => {
        if(!clients.has(req.params.client)){
            return res.status(503).send('Client not connected');
        }
        try{
            const response = await clients.get(req.params.client).call('Reset', { type: 'Soft' });
            log.debug(response);
            res.status(200).send('terminated connection');
        } catch(e) {
            log.error(e);
            res.status(503).send(e.message);
        }
    });

    app.post('/clients/:client/start', async (req, res) => {
        if(!clients.has(req.params.client)){
            return res.status(503).send('Client not connected');
        }
        const response = await clients.get(req.params.client).call('RemoteStartTransaction', { connectorId: 1, idTag: charger_name });
        log.debug(response);
        res.status(200).send('started charge session');
    });

    app.get('/clients/:client/transactions', async (req, res) => {
        if(!clients.has(req.params.client)){
            return res.status(503).send('Client not connected');
        }
        const client = clients.get(req.params.client);
        res.json(client.session.transactions);
    });

    app.get('/clients/:client/status', async (req, res) => {
        if(!clients.has(req.params.client)){
            return res.status(503).send('Client not connected');
        }
        const client = clients.get(req.params.client);
        res.set('content-type', 'text/plain');
        res.send(util.inspect(client.session, {compact: false, depth: 8}));
    });

    app.post('/clients/:client/stop', async (req, res) => {
        if(!clients.has(req.params.client)){
            return res.status(503).send('Client not connected');
        }
        const client = clients.get(req.params.client);
        if(Object.keys(client.session).indexOf('transactionId') === -1){
            // no known session...
            return res.status(400).send('No transaction in progress');
        }
        const response = await client.safeCall('RemoteStopTransaction', { transactionId: client.session.transactionId });
        log.debug(response);
        res.status(200).send('stopped charge session');
    });

    app.post('/softreset', async (req, res) => {
        for (const client of clients.values()) {
            const response = await client.safeCall('Reset', { type: 'Soft' });
            log.debug(response);
        }
        res.status(200).send('terminated connections');
    });

    app.get('/metrics', (req, res) => {
        res.set('content-type', 'text/plain');
        res.status(200).send(
`foo {charger="grizzbox"} 1
bar {charger="grizzbox"}
`
        );
    });

    const server = new RPCServer({
        protocols: ['ocpp1.6'], // server accepts ocpp1.6 subprotocol
        strictMode: false,      // disable strict validation of requests & responses
        // disable websocket pings, as this periodically disconnects grizzl-e chargers due to a
        // non-conformant pong implementation.
        // see https://github.com/lbbrhzn/ocpp/issues/442#issuecomment-1498396328 for details
        pingIntervalMs: 0,
    });
    httpServer.on('upgrade', server.handleUpgrade);

    server.auth((accept, reject, handshake) => {
        // accept the incoming client
        accept({
            // anything passed to accept() will be attached as a 'session' property of the client.
            sessionId: charger_name
        });
    });

    server.on('client', async (client) => {
        async function safeCall(...args){
            try{
                const result = await client.call(...args);
                return result;
            } catch(e) {
                return false;
            }
        }
        let triggeredStatus = false;
        client.safeCall = safeCall;
        function triggerStatus(){
            if(!triggeredStatus){
                // we need to trigger a StatusNotification to rebuild the startTime and endTime and respective timeouts
                triggeredStatus = true;
                setTimeout(async () => {
                    const resp = await client.safeCall('TriggerMessage', { requestedMessage: 'StatusNotification'});
                    log.debug(resp);
                }, 100);
            }
        }

        log.info(`${client.session.sessionId} connected!`); // `XYZ123 connected!`
        // clients reconnect often for whatever reason, keep the session vars
        ee.emit('client', client.session);
        client.session.transactions = {};
        if(clients.has(client.session.sessionId)){
            const oldsession = clients.get(client.session.sessionId).session;
            if(Object.hasOwn(oldsession, 'transactionId')){
                client.session.transactionId = oldsession.transactionId;
            }
            if(Object.hasOwn(oldsession, 'lastTransactionId')){
                client.session.lastTransactionId = oldsession.lastTransactionId;
            }
            client.session.transactions = oldsession.transactions;
            if(Object.hasOwn(oldsession, 'statusNotifications')){
                client.session.statusNotifications = oldsession.statusNotifications;
            }
            if(Object.hasOwn(oldsession, 'status')){
                client.session.status = oldsession.status;
            }
            if(Object.hasOwn(oldsession, 'startTime')){
                client.session.startTime = oldsession.startTime;
                client.session.startTimeout = oldsession.startTimeout;
            }
            if(Object.hasOwn(oldsession, 'endTime')){
                client.session.endTime = oldsession.endTime;
                client.session.endTimeout = oldsession.endTimeout;
            }
            triggerStatus();
        }
        client.session.connected = true;

        clients.set(client.session.sessionId, client);
        client.on('message', msg => {
            log.debug(`message: ${util.inspect(msg)}`);
        });
        client.on('socketError', err => {
            log.error(`socket error: ${err.message}`);
            client.session.connected = false;
        });
        client.on('disconnect', ({code, reason}) => {
            log.error(`client disconnected; code: ${code}, reason: ${reason}`);
            client.session.connected = false;
        });
        client.on('close', ({code, reason}) => {
            log.error(`client closed; code: ${code}, reason: ${reason}`);
            client.session.connected = false;
        });
        client.on('open', (result) => {
            log.info(`client (re)connected; result: ${result}`);
            client.session.connected = true;
        });
        client._ws.on('message', msg => {
            log.debug(`ws message: ${msg}`);
        });
        client._ws.on('ping', msg => {
            log.debug(`ws ping: ${msg}`);
        });
        client._ws.on('pong', msg => {
            log.debug(`ws pong: ${msg}`);
        });
        client._ws.on('error', msg => {
            log.debug(`ws error: ${msg}`);
        });
        client._ws.on('close', msg => {
            log.debug(`ws close: ${msg}`);
        });
        client.on('ping', ev => {
            log.debug(`client ping: ${ev.rtt}`);
        });

        // create a specific handler for handling BootNotification requests
        client.handle('BootNotification', ({params}) => {
            log.info(`Server got BootNotification from ${client.identity}:`, params);

            ee.emit(`${client.session.sessionId}:BootNotification`, params);
            // respond to accept the client
            return {
                status: "Accepted",
                interval: 300,
                currentTime: new Date().toISOString()
            };
        });

        // create a specific handler for handling Heartbeat requests
        client.handle('Heartbeat', ({params}) => {
            log.info(`Server got Heartbeat from ${client.identity}:`, params);

            ee.emit(`${client.session.sessionId}:Heartbeat`, params);
            // respond with the server's current time.
            return {
                currentTime: new Date().toISOString()
            };
        });

        // create a specific handler for handling StatusNotification requests
        client.handle('StatusNotification', ({params}) => {
            log.info(`Server got StatusNotification from ${client.identity}:`, params);
            log.debug(`status: ${params.status}`);
            client.session.status = params.status;
            client.session.statusNotifications ??= [];
            client.session.statusNotifications.push(params);
            const startTime = calculateStartTime();
            const now = moment();
            const dayOfWeek = now.day();
            log.silly(`day of week: ${dayOfWeek}`);
            // available == waiting to be plugged in
            // preparing == car is plugged in
            if(params.status == 'Preparing'){
                log.info(`startTime set to ${startTime.format()}`);
                if(client.session.startTimeout){
                    clearTimeout(client.session.startTimeout);
                }
                client.session.startTime = startTime.format();
                client.session.startTimeout = setTimeout(async () => {
                    delete client.session.startTimeout;
                    const endTime = moment();
                    const dayOfWeek = now.day();
                    log.silly(`day of week: ${dayOfWeek}`);
                    if(dayOfWeek == 0 || dayOfWeek == 6 || dayOfWeek == 7){
                        endTime.hour(14).minute(0).second(0);
                    } else {
                        endTime.hour(6).minute(0).second(0);
                    }
                    const response = await safeCall('RemoteStartTransaction', { connectorId: params.connectorId, idTag: charger_name });

                    if (response.status === 'Accepted') {
                        log.info('Remote start worked!', response);
                    } else {
                        log.warn('Remote start rejected.', response);
                        return;
                    }
                    if(client.session.endTimeout){
                        clearTimeout(client.session.endTimeout);
                    }
                    client.session.endTime = endTime.format();
                    client.session.endTimeout = setTimeout(async () => {
                        delete client.session.endTimeout;
                        const response = await safeCall('RemoteStopTransaction', { transactionId: client.session.transactionId });
                        if(response.status === 'Accepted'){
                            log.info('Remote stop worked!', response);
                        } else {
                            log.warn('Remote stop rejected.', response);
                        }
                    }, endTime.diff(now));
                }, startTime.diff(now));
            } else if(params.status == 'Available'){
                // car is not plugged in, clean up any transactions in progress
                if(Object.hasOwn(client.session,'transactionId')){
                    client.session.lastTransactionId = client.session.transactionId;
                    client.session.lastTransaction = client.session.transactions[client.session.transactionId];
                    delete client.session.transactionId;
                    if(Object.hasOwn(client.session,'endTimeout')){
                        clearTimeout(client.session.endTimeout);
                        delete client.session.endTimeout;
                    }
                    if(Object.hasOwn(client.session,'endTime')){
                        delete client.session.endTime;
                    }
                }
            }
            ee.emit(`${client.session.sessionId}:StatusNotification`, params);
            return {};
        });

        client.handle('StartTransaction', ({params}) => {
            log.info(`Server got StartTransaction from ${client.identity}:`, params);
            //console.log(`status: ${params.status}`);
            const now = moment();
            const startTime = moment();
            const dayOfWeek = now.day();
            log.silly(`day of week: ${dayOfWeek}`);
            // available == waiting to be plugged in
            // preparing == car is plugged in
            client.session.transactionId ??= 0;
            client.session.transactionId++;
            if(Object.keys(client.session).indexOf('lastTransactionId') !== -1 && !isNaN(client.session.lastTransactionId)){
                client.session.transactionId = client.session.lastTransactionId+1;
            }
            ee.emit(`${client.session.sessionId}:StartTransaction`, params);
            client.session.transactions ??= {};
            client.session.transactions[client.session.transactionId] = {meterValues: []};
            return {
                idTagInfo: {status: 'Accepted'},
                transactionId: client.session.transactionId
            };
        });

        client.handle('StopTransaction', ({params}) => {
            log.info(`Server got StopTransaction from ${client.identity}:`, params);
            const now = moment();
            const startTime = moment();
            const dayOfWeek = now.day();
            log.silly(`day of week: ${dayOfWeek}`);
            client.session.transactions[client.session.transactionId].meterValues.push(params.transactionData);
            if(Object.keys(client.session).indexOf('transactionId') !== -1 && client.session.transactionId == params.transactionId){
                delete client.session.transactionId;
            }
            client.session.lastTransactionId = params.transactionId;
            client.session.lastTransaction = params.transactionData;
            ee.emit(`${client.session.sessionId}:StopTransaction`, params);
            return {};
        });

        client.handle('MeterValues', ({params}) => {
            log.info(`Server got MeterValues from ${client.identity}:`, params);
            log.info(params.meterValue[0].sampledValue);
            ee.emit(`${client.session.sessionId}:MeterValues`, params);
            client.session.transactions[client.session.transactionId].meterValues.push(params);
            return {};
        });

        // create a wildcard handler to handle any RPC method
        client.handle(({method, params}) => {
            // This handler will be called if the incoming method cannot be handled elsewhere.
            log.warn(`Server got ${method} from ${client.identity}:`, params);

            ee.emit(`${client.session.sessionId}:${method}`, params);
            // throw an RPC error to inform the server that we don't understand the request.
            throw createRPCError("NotImplemented");
        });
    });

    //await server.listen(port);
    log.info(`server listening on port ${port}`);
}());
// vim: set et sw=4 sts=4 ts=4 :
