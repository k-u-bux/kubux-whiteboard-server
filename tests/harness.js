'use strict';
// Test harness: a throwaway server and protocol clients.
//
// startServer runs server.js in a fresh temporary directory (its own conf/, data/ and
// logs/) on a free port of 127.0.0.1, with the users given. Client speaks the wire
// protocol of protocol.md: plain JSON messages, matched by type or requestId.

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const { hashPassword } = require(path.join(ROOT, 'users.js'));

const uuid = () => crypto.randomUUID();
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.unref();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

// A fresh working directory for a server. users: [{ login, credential, id? }];
// the entries get their ids (fixed if given) and the hashes of their credentials.
function makeInstanceDir(users = []) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubux-whiteboard-test-'));
    for (const sub of ['conf', 'data', 'logs']) {
        fs.mkdirSync(path.join(dir, sub));
    }
    const entries = users.map(user => ({ id: user.id || uuid(), login: user.login, hash: hashPassword(user.credential) }));
    writeUsers(dir, entries);
    return { dir, entries };
}

function writeUsers(dir, entries) {
    fs.writeFileSync(path.join(dir, 'conf', 'users.json'), JSON.stringify(entries, null, 2), { mode: 0o600 });
}

function readUsers(dir) {
    return JSON.parse(fs.readFileSync(path.join(dir, 'conf', 'users.json'), 'utf8'));
}

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, (response) => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
        });
        request.on('error', reject);
        request.setTimeout(5000, () => request.destroy(new Error(`timeout on ${url}`)));
    });
}

// A server process in dir. Resolves once it answers HTTP; rejects with its output if
// it exits first (a refused start).
class ServerProcess {
    constructor(dir, port) {
        this.dir = dir;
        this.port = port;
        this.url = `http://127.0.0.1:${port}`;
        this.wsUrl = `ws://127.0.0.1:${port}/ws`;
        this.output = '';
        this.exitCode = undefined;
        this.clients = new Set();
    }

    start() {
        this.child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
            cwd: this.dir,
            env: { ...process.env, KUBUX_WHITEBOARD_URL: this.url },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        this.child.stdout.on('data', chunk => { this.output += chunk; });
        this.child.stderr.on('data', chunk => { this.output += chunk; });
        this.exited = new Promise(resolve => this.child.on('exit', (code, signal) => {
            this.exitCode = code === null ? signal : code;
            resolve(this.exitCode);
        }));
        return this.ready();
    }

    async ready() {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            if (this.exitCode !== undefined) {
                throw new Error(`server exited with ${this.exitCode} during startup:\n${this.output}`);
            }
            try {
                await httpGet(`${this.url}/robots.txt`);
                return this;
            } catch (error) {
                await sleep(50);
            }
        }
        throw new Error(`server did not start within 10 s:\n${this.output}`);
    }

    get running() {
        return this.exitCode === undefined;
    }

    // A client connected to this server, closed by stop()
    async connect() {
        const client = await Client.connect(this.wsUrl);
        this.clients.add(client);
        return client;
    }

    // SIGTERM persists everything at once; open connections may keep the process
    // alive, so they are closed first and a process that lingers is killed.
    async stop() {
        for (const client of this.clients) {
            client.close();
        }
        this.clients.clear();
        if (!this.running) {
            return this.exitCode;
        }
        this.child.kill('SIGTERM');
        const code = await Promise.race([this.exited, sleep(5000).then(() => 'timeout')]);
        if (code === 'timeout') {
            this.child.kill('SIGKILL');
            return this.exited;
        }
        return code;
    }

    // An abrupt end, as in a crash: nothing is persisted
    async kill() {
        for (const client of this.clients) {
            client.close();
        }
        this.clients.clear();
        if (this.running) {
            this.child.kill('SIGKILL');
        }
        return this.exited;
    }
}

// Start a server. users as for makeInstanceDir, or dir to reuse an instance directory.
async function startServer({ users = [], dir } = {}) {
    let entries;
    if (!dir) {
        ({ dir, entries } = makeInstanceDir(users));
    }
    const server = new ServerProcess(dir, await freePort());
    server.users = entries || (fs.existsSync(path.join(dir, 'conf', 'users.json')) ? readUsers(dir) : []);
    await server.start();
    return server;
}

function removeDir(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

// A protocol client. Every message received is kept in the inbox until a next() or
// request() takes it, so a test can wait for a message that has already arrived.
class Client {
    static connect(wsUrl) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(wsUrl);
            ws.once('open', () => resolve(new Client(ws)));
            ws.once('error', reject);
        });
    }

    constructor(ws) {
        this.ws = ws;
        this.id = uuid();
        this.inbox = [];
        this.waiters = [];
        this.closed = new Promise(resolve => ws.once('close', (code) => resolve(code)));
        ws.on('message', (text) => {
            const message = JSON.parse(text.toString());
            const waiter = this.waiters.find(candidate => candidate.match(message));
            if (waiter) {
                this.waiters.splice(this.waiters.indexOf(waiter), 1);
                clearTimeout(waiter.timer);
                waiter.resolve(message);
            } else {
                this.inbox.push(message);
            }
        });
        ws.on('error', () => {});
    }

    send(message) {
        this.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
    }

    // The next message that matches (a type, or a predicate), within timeout ms
    next(match, timeout = 5000) {
        const predicate = typeof match === 'function' ? match : (message => message.type === match);
        const index = this.inbox.findIndex(predicate);
        if (index !== -1) {
            return Promise.resolve(this.inbox.splice(index, 1)[0]);
        }
        return new Promise((resolve, reject) => {
            const waiter = { match: predicate, resolve };
            waiter.timer = setTimeout(() => {
                this.waiters.splice(this.waiters.indexOf(waiter), 1);
                reject(new Error(`no message matching ${typeof match === 'function' ? match.toString() : match} within ${timeout} ms`));
            }, timeout);
            this.waiters.push(waiter);
        });
    }

    // Resolves true if a matching message arrives within ms, false if none does
    async receives(match, ms) {
        try {
            await this.next(match, ms);
            return true;
        } catch (error) {
            return false;
        }
    }

    // Send a message with a fresh requestId; the answer that carries it
    request(message, timeout = 5000) {
        const requestId = uuid();
        this.send({ ...message, requestId });
        return this.next(answer => answer.requestId === requestId, timeout);
    }

    // Forget what has arrived so far (periodic pings and board-info, broadcasts)
    drain() {
        this.inbox = [];
    }

    close() {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
            this.ws.close();
        }
    }

    // Owner messages
    // ==============

    owner(type, login, credential, fields = {}) {
        return this.request({ type, login, passwd: credential, ...fields });
    }

    async createBoard(login, credential, boardPath) {
        const answer = await this.owner('create-board', login, credential, { path: boardPath, clientId: this.id });
        if (answer.type !== 'board-created') {
            throw new Error(`create-board ${boardPath}: ${JSON.stringify(answer)}`);
        }
        return { board: answer['board-uuid'], passwd: answer.passwd, firstPage: answer['first-page-uuid'] };
    }

    listBoards(login, credential) {
        return this.owner('list-boards', login, credential);
    }

    // Board and page messages
    // =======================

    registerBoard(board, page) {
        const message = { type: 'register-board', 'board-uuid': board, clientId: this.id };
        if (page !== undefined) {
            message['page-uuid'] = page;
        }
        return this.request(message);
    }

    registerPage(board, page, delta = 0) {
        return this.request({ type: 'register-page', 'board-uuid': board, 'page-uuid': page, delta, clientId: this.id });
    }

    // register-board and register-page, as the client does on opening a board
    async open(board, page) {
        const registered = await this.registerBoard(board, page);
        const pageId = page || registered['first-page-uuid'];
        return this.registerPage(board, pageId);
    }

    fullPage(board, page, delta = 0, register = false) {
        return this.request({ type: 'fullPage-requests', 'board-uuid': board, 'page-uuid': page, delta, register });
    }

    pageInfo(board, page, delta = 0, register = false) {
        return this.request({ type: 'page-info-request', 'board-uuid': board, 'page-uuid': page, delta, register });
    }

    boardInfo(board, register = false) {
        return this.request({ type: 'board-info-request', 'board-uuid': board, register });
    }

    replay(board, page, present, presentHash, register = false) {
        return this.request({ type: 'replay-requests', 'board-uuid': board, 'page-uuid': page, present, 'present-hash': presentHash, register });
    }

    // Send a proposal; the accept or decline for its action
    propose(board, passwd, page, payload) {
        this.send({ type: 'mod-action-proposals', passwd, 'board-uuid': board, 'page-uuid': page, payload, 'before-hash': '0' });
        const actionUuid = payload.uuid;
        return this.next(message => (message.type === 'accept' || message.type === 'decline') && message['action-uuid'] === actionUuid);
    }

    // A page action. The proposal has no requestId of its own; one given at the top level
    // is used for the answers (fullPage, page-info, board-info), so the action's uuid is
    // sent along to match the answer by.
    proposePageAction(board, passwd, page, payload) {
        this.send({ type: 'mod-action-proposals', passwd, 'board-uuid': board, 'page-uuid': page, payload, requestId: payload.uuid });
        return this.next(message => message.requestId === payload.uuid && message.type !== 'board-info');
    }
}

// Actions
// =======

// A valid stroke (the 13-element array of protocol.md) through the given points
function stroke(points = [[10, 10], [20, 20]], options = {}) {
    return [
        options.type || 'stroke',
        options.path || 'opl',
        points.map(([x, y]) => [x, y, 0.5, 1700000000000]),
        options.color || '#000000',
        options.width || 2,
        [1, 0, 0, 1, 0, 0],
        options.opacity === undefined ? 1 : options.opacity,
        0,
        0,
        options.dash || [],
        1,
        options.layer || 0,
        options.pen || 0
    ];
}

const draw = (strokeArray = stroke()) => ({ type: 'draw', uuid: uuid(), stroke: strokeArray });
const erase = (target) => ({ type: 'erase', uuid: uuid(), targetActionUuid: target });
const group = (actions) => ({ type: 'group', uuid: uuid(), actions });
const undo = (target) => ({ type: 'undo', uuid: uuid(), targetActionUuid: target });
const redo = (target) => ({ type: 'redo', uuid: uuid(), targetActionUuid: target });
const newPage = () => ({ type: 'new page', uuid: uuid() });
const deletePage = () => ({ type: 'delete page', uuid: uuid() });

module.exports = {
    ROOT,
    uuid,
    sleep,
    httpGet,
    makeInstanceDir,
    writeUsers,
    readUsers,
    startServer,
    removeDir,
    Client,
    stroke,
    draw,
    erase,
    group,
    undo,
    redo,
    newPage,
    deletePage
};
