const config = require('./config.json');
const moment = require('moment');
const { EventEmitter } = require('node:events');
const clients = new Map();

function calculateStartTime(){
    const now = moment();
    const startTime = moment();
    const dayOfWeek = now.day();
    console.log(`day of week: ${dayOfWeek}`);
    if(dayOfWeek == 0 || dayOfWeek == 6 || dayOfWeek == 7){
        console.log(`weekend`);
        console.log(`now: ${now.format()}`);
        // this is the weekend
        if(now.hour() < 14){
            console.log(`not yet 2:00pm`,);
            // start it!
        } else {
            console.log(`past 2:00pm, deferring until tomorrow`);
            // set it to midnight
            startTime.hour(0).minute(0).second(0).add(1, 'day');
        }
    } else {
        // this is a weekday
        console.log(`weekday`);
        console.log(`now: ${now.format()}`);
        if(now.hour() < 6){
            console.log(`not yet 6:00am`,);
            // start it!
        } else {
            // set it to midnight
            console.log(`past 6:00am, deferring until tomorrow`);
            startTime.hour(0).minute(0).second(0).add(1, 'day');
        }
    }
    return startTime;
}

(async function(){
    const { RPCServer, createRPCError } = require('ocpp-rpc');
    const { port, charger_name } = config;
    const express = require('express');
    const app = express();
    const httpServer = app.listen(port);
    const util = require('util');

	var log = console.log;

	console.log = function () {
		var first_parameter = arguments[0];
		var other_parameters = Array.prototype.slice.call(arguments, 1);

		function formatConsoleDate (date) {
			var hour = date.getHours();
			var minutes = date.getMinutes();
			var seconds = date.getSeconds();
			var milliseconds = date.getMilliseconds();

			return '[' +
				((hour < 10) ? '0' + hour: hour) +
				':' +
				((minutes < 10) ? '0' + minutes: minutes) +
				':' +
				((seconds < 10) ? '0' + seconds: seconds) +
				'.' +
				('00' + milliseconds).slice(-3) +
				'] ';
		}

        if(other_parameters.length){
            log.apply(console, ['['+moment().format()+'] ' + first_parameter].concat(other_parameters));
        } else {
            log.apply(console, ['['+moment().format()+'] ', first_parameter]);
        }
	};

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
        console.log(response);
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
        console.log(response);
        //res.json(response);
    });

    app.get('/clients/:client/softreset', async (req, res) => {
        if(!clients.has(req.params.client)){
            return res.status(503).send('Client not connected');
        }
        const response = await clients.get(req.params.client).call('Reset', { type: 'Soft' });
        console.log(util.inspect(response));
        res.status(200).send('terminated connection');
    });

    app.get('/clients/:client/start', async (req, res) => {
        if(!clients.has(req.params.client)){
            return res.status(503).send('Client not connected');
        }
        const response = await clients.get(req.params.client).call('RemoteStartTransaction', { connectorId: 1, idTag: charger_name });
        console.log(util.inspect(response));
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
        console.log(util.inspect(response));
        res.status(200).send('stopped charge session');
    });

    app.get('/softreset', async (req, res) => {
        for (const client of clients.values()) {
            const response = await client.call('Reset', { type: 'Soft' });
            console.log(util.inspect(response));
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
        console.log(`${client.session.sessionId} connected!`); // `XYZ123 connected!`
        clients.set(client.session.sessionId, client);
        client.session.ee = new EventEmitter();

        // create a specific handler for handling BootNotification requests
        client.handle('BootNotification', ({params}) => {
            console.log(`Server got BootNotification from ${client.identity}:`, params);

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
            console.log(`Server got Heartbeat from ${client.identity}:`, params);

            client.session.ee.emit('Heartbeat', params);
            // respond with the server's current time.
            return {
                currentTime: new Date().toISOString()
            };
        });

        // create a specific handler for handling StatusNotification requests
        client.handle('StatusNotification', ({params}) => {
            console.log(`Server got StatusNotification from ${client.identity}:`, params);
            console.log(`status: ${params.status}`);
            const startTime = calculateStartTime();
            const now = moment();
            const dayOfWeek = now.day();
            console.log(`day of week: ${dayOfWeek}`);
            // available == waiting to be plugged in
            // preparing == car is plugged in
            if(params.status == 'Preparing'){
                console.log('calculating start time...');
                console.log(`startTime set to ${startTime.format()}`);
                setTimeout(async () => {
                    const endTime = moment();
                    const dayOfWeek = now.day();
                    console.log(`day of week: ${dayOfWeek}`);
                    if(dayOfWeek == 0 || dayOfWeek == 6 || dayOfWeek == 7){
                        endTime.hour(14);
                    } else {
                        endTime.hour(6);
                    }
                    const response = await client.call('RemoteStartTransaction', { connectorId: params.connectorId, idTag: charger_name });

                    if (response.status === 'Accepted') {
                        console.log('Remote start worked!');
                    } else {
                        console.log('Remote start rejected.');
                    }
                    setTimeout(async () => {
                        const response = await client.call('RemoteStopTransaction', { connectorId: params.connectorId, idTag: charger_name });
                    }, endTime.diff(now));
                }, startTime.diff(now));
            }
            client.session.ee.emit('StatusNotification', params);
            return {};
        });

        client.handle('StartTransaction', ({params}) => {
            console.log(`Server got StartTransaction from ${client.identity}:`, params);
            //console.log(`status: ${params.status}`);
            const now = moment();
            const startTime = moment();
            const dayOfWeek = now.day();
            console.log(`day of week: ${dayOfWeek}`);
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
            return {
                idTagInfo: {status: 'Accepted'},
                transactionId: client.session.transactionId
            };
        });

        client.handle('StopTransaction', ({params}) => {
            console.log(`Server got StopTransaction from ${client.identity}:`, params);
            const now = moment();
            const startTime = moment();
            const dayOfWeek = now.day();
            console.log(`day of week: ${dayOfWeek}`);
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
            console.log(`Server got MeterValues from ${client.identity}:`, params);
            console.log(params.meterValue[0].sampledValue);
            client.session.ee.emit('MeterValues', params);
            return {};
        });

        // create a wildcard handler to handle any RPC method
        client.handle(({method, params}) => {
            // This handler will be called if the incoming method cannot be handled elsewhere.
            console.log(`Server got ${method} from ${client.identity}:`, params);

            client.session.ee.emit(method, params);
            // throw an RPC error to inform the server that we don't understand the request.
            throw createRPCError("NotImplemented");
        });
    });

    //await server.listen(port);
    console.log(`server listening on port ${port}`);
}());
