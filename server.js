const config = require('./config.json');
const { port, charger_name, loglevel = 'info' } = config;
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
    const logger = loglevels[level] >= level ? console.error : console.log;
    if(loglevels[level] < loglevel){
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

(async function(){
    const { RPCServer, createRPCError } = require('ocpp-rpc');
    const express = require('express');
    const app = express();
    const httpServer = app.listen(port, '0.0.0.0');
    const util = require('util');

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
        const options = {};
        if(req.query.pretty){
            options.compact = false;
        }
        return res.send(util.inspect(clients.get(req.params.client), options));
    });

    app.get('/clients/:client/config', async (req, res) => {
        if(!clients.has(req.params.client)){
            return res.status(503).send('Client not connected');
        }
        const response = await clients.get(req.params.client).call('GetConfiguration', { });
        log.debug(response);
        res.json(response);
    });

    app.get('/clients/:client/trigger/:msg', async (req, res) => {
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
            }
        }, 30000);
        client.session.ee.once(req.params.msg, resp => {
            if(!sent){
                res.json(resp);
                clearTimeout(timeout);
            }
        });
        const response = await client.call('TriggerMessage', { requestedMessage: req.params.msg});
        log.debug(response);
        //res.json(response);
    });

    app.get('/clients/:client/softreset', async (req, res) => {
        if(!clients.has(req.params.client)){
            return res.status(503).send('Client not connected');
        }
        const response = await clients.get(req.params.client).call('Reset', { type: 'Soft' });
        log.debug(response);
        res.status(200).send('terminated connection');
    });

    app.get('/clients/:client/start', async (req, res) => {
        if(!clients.has(req.params.client)){
            return res.status(503).send('Client not connected');
        }
        const response = await clients.get(req.params.client).call('RemoteStartTransaction', { connectorId: 1, idTag: charger_name });
        log.debug(response);
        res.status(200).send('started charge session');
    });

    app.get('/clients/:client/status', async (req, res) => {
        if(!clients.has(req.params.client)){
            return res.status(503).send('Client not connected');
        }
        const client = clients.get(req.params.client);
        res.json(client.session);
    });

    app.get('/clients/:client/stop', async (req, res) => {
        if(!clients.has(req.params.client)){
            return res.status(503).send('Client not connected');
        }
        const client = clients.get(req.params.client);
        if(Object.keys(client.session).indexOf('transactionId') === -1){
            // no known session...
            return res.status(400).send('No transaction in progress');
        }
        const response = await client.call('RemoteStopTransaction', { transactionId: client.session.transactionId });
        log.debug(response);
        res.status(200).send('stopped charge session');
    });

    app.get('/softreset', async (req, res) => {
        for (const client of clients.values()) {
            const response = await client.call('Reset', { type: 'Soft' });
            log.debug(response);
        }
        res.status(200).send('terminated connections');
    });

    const server = new RPCServer({
        protocols: ['ocpp1.6'], // server accepts ocpp1.6 subprotocol
        strictMode: false,      // disable strict validation of requests & responses
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
        log.info(`${client.session.sessionId} connected!`); // `XYZ123 connected!`
        // clients reconnect often for whatever reason, keep the session vars
        client.session.transactions = {};
        client.session.ee = new EventEmitter();
        if(clients.has(client.session.sessionId)){
            const oldsession = clients.get(client.session.sessionId).session;
            client.session.lastTransactionId = oldsession.lastTransactionId;
            client.session.transactions = oldsession.transactions;
            client.session.ee = oldsession.ee;
        }
        clients.set(client.session.sessionId, client);

        // create a specific handler for handling BootNotification requests
        client.handle('BootNotification', ({params}) => {
            log.info(`Server got BootNotification from ${client.identity}:`, params);

            client.session.ee.emit('BootNotification', params);
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

            client.session.ee.emit('Heartbeat', params);
            // respond with the server's current time.
            return {
                currentTime: new Date().toISOString()
            };
        });

        // create a specific handler for handling StatusNotification requests
        client.handle('StatusNotification', ({params}) => {
            log.info(`Server got StatusNotification from ${client.identity}:`, params);
            log.debug(`status: ${params.status}`);
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
                    const endTime = moment();
                    const dayOfWeek = now.day();
                    log.silly(`day of week: ${dayOfWeek}`);
                    if(dayOfWeek == 0 || dayOfWeek == 6 || dayOfWeek == 7){
                        endTime.hour(14);
                    } else {
                        endTime.hour(6);
                    }
                    const response = await client.call('RemoteStartTransaction', { connectorId: params.connectorId, idTag: charger_name });

                    if (response.status === 'Accepted') {
                        log.info('Remote start worked!');
                    } else {
                        log.warn('Remote start rejected.');
                    }
                    if(client.session.endTimeout){
                        clearTimeout(client.session.endTimeout);
                    }
                    client.session.endTime = endTime.format();
                    client.session.endTimeout = setTimeout(async () => {
                        const response = await client.call('RemoteStopTransaction', { connectorId: params.connectorId, idTag: charger_name });
                    }, endTime.diff(now));
                }, startTime.diff(now));
            }
            client.session.ee.emit('StatusNotification', params);
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
            if(Object.keys(client.session).indexOf('transactionId') !== -1){
                client.session.transactionId++;
            } else if(Object.keys(client.session).indexOf('lastTransactionId') !== -1){
                client.session.transactionId = client.session.lastTransactionId+1;
            } else {
                client.session.transactionId = 1;
            }
            client.session.ee.emit('StartTransaction', params);
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
            // available == waiting to be plugged in
            // preparing == car is plugged in
            if(Object.keys(client.session).indexOf('transactionId') !== -1 && client.session.transactionId == params.transactionId){
                delete client.session.transactionId;
            }
            client.session.lastTransactionId = params.transactionId;
            client.session.lastTransaction = params.transactionData;
            client.session.ee.emit('StopTransaction', params);
            return {};
        });

        client.handle('MeterValues', ({params}) => {
            log.info(`Server got MeterValues from ${client.identity}:`, params);
            log.info(params.meterValue[0].sampledValue);
            client.session.ee.emit('MeterValues', params);
            client.session.transactions[client.session.transactionId].meterValues.push(params);
            return {};
        });

        // create a wildcard handler to handle any RPC method
        client.handle(({method, params}) => {
            // This handler will be called if the incoming method cannot be handled elsewhere.
            log.warn(`Server got ${method} from ${client.identity}:`, params);

            client.session.ee.emit(method, params);
            // throw an RPC error to inform the server that we don't understand the request.
            throw createRPCError("NotImplemented");
        });
    });

    //await server.listen(port);
    log.info(`server listening on port ${port}`);
}());
// vim: set et sw=4 sts=4 ts=4 :
