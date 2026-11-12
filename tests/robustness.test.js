'use strict';
// Malformed input: the server answers what protocol.md says, drops the rest, and keeps
// running (protocol.md: Validation and rejection, Error Handling).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { ROOT, uuid, startServer, removeDir, draw } = require('./harness');
const { NULL_UUID } = require(require('path').join(ROOT, 'shared.js'));

const ANN = { login: 'ann', credential: 'ann' };

describe('malformed input', () => {
    let server;
    let client;
    let board;

    before(async () => {
        server = await startServer({ users: [ANN] });
        client = await server.connect();
        board = await client.createBoard(ANN.login, ANN.credential, 'robust');
        await client.open(board.board);
    });
    after(async () => {
        await server.stop();
        removeDir(server.dir);
    });

    // the connection and the server still work
    async function stillWorks(connection = client) {
        assert.ok(server.running, `server exited:\n${server.output}`);
        assert.equal((await connection.boardInfo(board.board)).type, 'board-info');
    }

    it('text that is not JSON: an error with the parse message, no requestId', async () => {
        for (const text of ['{', 'not json', '{"type": "register-board",}', '']) {
            client.send(text);
            const error = await client.next('error');
            assert.equal(error.requestId, undefined);
            assert.ok(error.message.length > 0);
        }
        await stillWorks();
    });

    it('an unknown type, or none: Unhandled message type', async () => {
        const cases = [
            [{ type: 'no-such-type' }, 'Unhandled message type: no-such-type'],
            [{ type: 'toString' }, 'Unhandled message type: toString'],
            [{ type: 'hasOwnProperty' }, 'Unhandled message type: hasOwnProperty'],
            [{ type: '__proto__' }, 'Unhandled message type: __proto__'],
            [{ type: 'constructor' }, 'Unhandled message type: constructor'],
            [{}, 'Unhandled message type: undefined'],
            [[1, 2], 'Unhandled message type: undefined'],
            [42, 'Unhandled message type: undefined'],
            ['"text"', 'Unhandled message type: undefined'],
            // client input of any length: only the first 20 characters are logged and sent back
            [{ type: 'x'.repeat(20) }, `Unhandled message type: ${'x'.repeat(20)}`],
            [{ type: 'x'.repeat(21) }, `Unhandled message type: ${'x'.repeat(20)}...`],
            [{ type: 'y'.repeat(4 * 1024 * 1024) }, `Unhandled message type: ${'y'.repeat(20)}...`]
        ];
        for (const [message, answer] of cases) {
            client.send(typeof message === 'string' ? message : JSON.stringify(message));
            assert.equal((await client.next('error')).message, answer, JSON.stringify(message));
        }
        await stillWorks();
    });

    it('null and false are dropped', async () => {
        client.send('null');
        client.send('false');
        assert.equal(await client.receives('error', 300), false);
        await stillWorks();
    });

    it('every message type that fails validation is dropped without a reply', async () => {
        const requestId = uuid();
        const page = board.firstPage;
        const broken = [
            { type: 'register-board', 'board-uuid': 'x' },
            { type: 'register-board', 'board-uuid': board.board, 'page-uuid': 5 },
            { type: 'register-page', 'board-uuid': board.board, 'page-uuid': page, delta: 'one' },
            { type: 'page-info-request', 'board-uuid': board.board, 'page-uuid': page, register: 1 },
            { type: 'fullPage-requests', 'board-uuid': board.board, 'page-uuid': page, delta: 0 },
            { type: 'replay-requests', 'board-uuid': board.board, 'page-uuid': page, present: 0.5, 'present-hash': 'h', register: false },
            { type: 'board-info-request', 'board-uuid': 'x' },
            { type: 'shuffle-proposal', 'board-uuid': board.board, passwd: board.passwd, before: 'x', after: [page] },
            { type: 'mod-action-proposals', passwd: board.passwd, 'board-uuid': board.board, 'page-uuid': page, payload: { type: 'draw', uuid: uuid(), stroke: [] } },
            { type: 'mod-action-proposals', passwd: board.passwd, 'board-uuid': board.board, 'page-uuid': page, payload: null },
            { type: 'change-credential', login: ANN.login, passwd: ANN.credential },
            { type: 'create-board', login: ANN.login, passwd: ANN.credential, path: null },
            { type: 'list-boards', login: { toString: 1 }, passwd: ANN.credential },
            { type: 'set-path', login: ANN.login, passwd: ANN.credential, 'board-uuid': board.board },
            { type: 'rename-prefix', login: ANN.login, passwd: ANN.credential, from: 'a', to: ['b'] }
        ];
        for (const message of broken) {
            client.send({ ...message, requestId });
        }
        assert.equal(await client.receives(message => message.requestId === requestId || message.type === 'error' || message.type === 'decline', 1000), false);
        await stillWorks();
    });

    it('deeply nested groups and huge numbers do not hurt', async () => {
        let nested = draw();
        for (let depth = 0; depth < 1000; ++depth) { nested = { type: 'group', uuid: uuid(), actions: [nested] }; }
        client.send({ type: 'mod-action-proposals', passwd: board.passwd, 'board-uuid': board.board, 'page-uuid': board.firstPage, payload: nested });
        client.send(`{"type": "register-page", "board-uuid": "${board.board}", "page-uuid": "${board.firstPage}", "delta": 1e308}`);
        await stillWorks();
        // a huge delta is clamped, not an error
        const registered = await client.registerPage(board.board, board.firstPage, Number.MAX_SAFE_INTEGER);
        assert.equal(registered['page-uuid'], board.firstPage);
    });

    it('a message over 5 MiB closes that connection only', async () => {
        const big = await server.connect();
        big.send(JSON.stringify({ type: 'register-board', padding: 'x'.repeat(5 * 1024 * 1024 + 10) }));
        assert.equal(await big.closed, 1009);
        await stillWorks();
        // just under the limit is fine
        const fine = await server.connect();
        fine.send(JSON.stringify({ type: 'nothing', padding: 'x'.repeat(4 * 1024 * 1024) }));
        assert.equal((await fine.next('error', 10000)).message, 'Unhandled message type: nothing');
        fine.close();
    });

    it('a connection that leaves during a credential check, or mid-stream, does no harm', async () => {
        for (let i = 0; i < 5; ++i) {
            const leaving = await server.connect();
            leaving.send({ type: 'list-boards', login: ANN.login, passwd: ANN.credential, requestId: uuid() });
            leaving.send({ type: 'create-board', login: ANN.login, passwd: ANN.credential, path: `left-${i}`, requestId: uuid() });
            leaving.ws.terminate();
        }
        const brief = await server.connect();
        await brief.open(board.board);
        brief.send({ type: 'mod-action-proposals', passwd: board.passwd, 'board-uuid': board.board, 'page-uuid': board.firstPage, payload: draw() });
        brief.ws.terminate();
        await stillWorks();
        assert.equal((await client.listBoards(ANN.login, ANN.credential)).type, 'board-list');
    });

    it('a uuid field that is not a string is no uuid: an id in a list is dropped', async () => {
        const requestId = uuid();
        client.send({ type: 'board-info-request', 'board-uuid': [board.board], requestId });
        assert.equal(await client.receives(message => message.requestId === requestId, 500), false);
    });

    it('a type, requestId or action-uuid that is not a string: dropped without a reply', async () => {
        let deep = '1';
        for (let depth = 0; depth < 10000; ++depth) { deep = `[${deep}]`; }
        for (const key of ['type', 'requestId', 'action-uuid']) {
            for (const value of [deep, '["board-info-request"]', '42', 'null', '{}']) {
                client.send(`{"type": "board-info-request", "board-uuid": "${board.board}", "register": false, "${key}": ${value}}`);
            }
        }
        // answered, these would get an error or a board-info with the bad requestId (the periodic one has NULL_UUID)
        assert.equal(await client.receives(message => message.type === 'error' || message.type === 'board-info' && message.requestId !== NULL_UUID, 1000), false);
        await stillWorks();
    });

    it('a key the protocol does not name, in a message or an action: dropped without a reply', async () => {
        const target = { 'board-uuid': board.board, 'page-uuid': board.firstPage };
        const proposal = (payload, extra = {}) => ({ type: 'mod-action-proposals', passwd: board.passwd, ...target, payload, ...extra });
        const withKey = (action) => ({ ...action, extra: 1 });
        const proposals = [
            proposal(draw(), { extra: 1 }),
            proposal(withKey(draw())),
            proposal(withKey({ type: 'erase', uuid: uuid(), targetActionUuid: uuid() })),
            proposal(withKey({ type: 'group', uuid: uuid(), actions: [draw()] })),
            proposal({ type: 'group', uuid: uuid(), actions: [withKey(draw())] }),
            proposal({ type: 'group', uuid: uuid(), actions: [{ type: 'group', uuid: uuid(), actions: [withKey(draw())] }] }),
            proposal(withKey({ type: 'undo', uuid: uuid(), targetActionUuid: uuid() })),
            proposal(withKey({ type: 'new page', uuid: uuid() })),
            proposal(withKey({ type: 'delete page', uuid: uuid() }))
        ];
        for (const message of proposals) {
            client.send(message);
        }
        const requestId = uuid();
        client.send({ type: 'board-info-request', 'board-uuid': board.board, register: false, requestId, extra: 1 });
        client.send({ type: 'replay-requests', ...target, present: 0, 'present-hash': 'x', register: false, requestId, extra: 1 });
        client.send({ type: 'list-boards', login: ANN.login, passwd: ANN.credential, requestId, extra: 1 });
        assert.equal(await client.receives(message => ['accept', 'decline', 'error', 'fullPage', 'page-info'].includes(message.type)
            || message.requestId === requestId, 1000), false);
        // the same without the extra key is answered
        assert.equal((await client.propose(board.board, board.passwd, board.firstPage, draw())).type, 'accept');
        await stillWorks();
    });

    it('many connections at once', async () => {
        const many = await Promise.all(Array.from({ length: 50 }, () => server.connect()));
        const answers = await Promise.all(many.map(connection => connection.registerBoard(board.board)));
        assert.ok(answers.every(answer => answer.type === 'board-registered'));
        for (const connection of many) {
            connection.close();
        }
        await stillWorks();
    });
});

// Fixed bugs, each on a server of its own: the first three ended the server process,
// the fourth let one connection fill the server's memory, the last wrote a stale copy of
// a board over its file.
describe('malformed input, fixed bugs', () => {
    it('deeply nested JSON does not end the server', async () => {
        const server = await startServer();
        try {
            const client = await server.connect();
            let deepJson = '1';
            for (let depth = 0; depth < 10000; ++depth) { deepJson = `[${deepJson}]`; }
            client.send(`{"type": "nothing", "x": ${deepJson}}`);
            // the parse succeeds: the answer is the error for the unknown type
            assert.equal((await client.next('error')).message, 'Unhandled message type: nothing');
            assert.ok(server.running);
        } finally {
            await server.stop();
            removeDir(server.dir);
        }
    });

    // The dropped proposal was stringified for the log, which overflowed the stack.
    it('an invalid proposal with deeply nested content does not end the server', async () => {
        const server = await startServer();
        try {
            const client = await server.connect();
            const deep = '['.repeat(20000) + ']'.repeat(20000);
            client.send(`{"type": "mod-action-proposals", "x": ${deep}}`);
            // dropped without a reply; the next message is still answered
            client.send({ type: 'nothing' });
            assert.equal((await client.next('error')).message, 'Unhandled message type: nothing');
            assert.ok(server.running);
        } finally {
            await server.stop();
            removeDir(server.dir);
        }
    });

    // The action was accepted with its extra key, whose hash overflowed the stack.
    it('a valid action with a deeply nested extra key does not end the server', async () => {
        const server = await startServer({ users: [ANN] });
        try {
            const client = await server.connect();
            const b = await client.createBoard(ANN.login, ANN.credential, 'deep');
            const deep = '['.repeat(20000) + ']'.repeat(20000);
            const action = JSON.stringify(draw());
            const payload = `${action.slice(0, -1)}, "x": ${deep}}`;
            client.send(`{"type": "mod-action-proposals", "passwd": "${b.passwd}", "board-uuid": "${b.board}", "page-uuid": "${b.firstPage}", "payload": ${payload}}`);
            client.send({ type: 'nothing' });
            assert.equal((await client.next('error')).message, 'Unhandled message type: nothing');
            assert.equal(await client.receives(message => message.type === 'accept', 500), false);
            assert.ok(server.running);
        } finally {
            await server.stop();
            removeDir(server.dir);
        }
    });

    // Replies to a client that did not read piled up in the server without limit.
    it('a client that does not read its replies is cut off', async () => {
        const { stroke, sleep } = require('./harness');
        const server = await startServer({ users: [ANN] });
        try {
            const owner = await server.connect();
            const b = await owner.createBoard(ANN.login, ANN.credential, 'large');
            // a page of about 1.5 MB on the wire
            const points = Array.from({ length: 50000 }, (_, i) => [i, i]);
            assert.equal((await owner.propose(b.board, b.passwd, b.firstPage, draw(stroke(points)))).type, 'accept');
            // 100 cheap requests for it, about 150 MB of replies, and none read
            const reader = await server.connect();
            reader.ws._socket.pause();
            for (let i = 0; i < 100; ++i) {
                reader.send({ type: 'fullPage-requests', 'board-uuid': b.board, 'page-uuid': b.firstPage, delta: 0, register: false, requestId: uuid() });
            }
            await sleep(3000);
            // reading now, it gets what the network held and then the end of the connection
            reader.ws._socket.resume();
            assert.equal(await Promise.race([reader.closed, sleep(20000).then(() => 'still open')]), 1006);
            assert.ok(server.running);
            assert.equal((await owner.boardInfo(b.board)).type, 'board-info');
        } finally {
            await server.stop();
            removeDir(server.dir);
        }
    });

    it('a board id in a list does not load a second copy of the board', async () => {
        const fs = require('fs');
        const path = require('path');
        const { deserialize } = require(path.join(__dirname, '..', 'shared.js'));
        const { newPage, sleep } = require('./harness');
        const server = await startServer({ users: [ANN] });
        try {
            const owner = await server.connect();
            const b = await owner.createBoard(ANN.login, ANN.credential, 'victim');
            await owner.open(b.board);
            await owner.proposePageAction(b.board, b.passwd, b.firstPage, newPage());
            // a viewer with the board id only, in a list
            const viewer = await server.connect();
            viewer.send({ type: 'board-info-request', 'board-uuid': [b.board], requestId: uuid() });
            await sleep(11000); // the periodic save
            const file = deserialize(fs.readFileSync(path.join(server.dir, 'data', `${b.board}.board`), 'utf8'));
            assert.equal(file.pageOrder.length, 2);
        } finally {
            await server.stop();
            removeDir(server.dir);
        }
    });
});
