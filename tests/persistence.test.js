'use strict';
// What survives a restart, the periodic save, and what the server refuses to start or
// run on (protocol.md: Board index, Deletion Map, Hash Chain; readme.md).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { uuid, sleep, startServer, makeInstanceDir, removeDir, draw, undo, newPage, deletePage } = require('./harness');
const { serialize, deserialize, hashAny, hashNext, compileVisualState } = require(path.join(__dirname, '..', 'shared.js'));

const ANN = { login: 'ann', credential: 'ann' };

function chain(pageId, history) {
    const hashes = [hashAny(pageId)];
    for (const action of history) {
        hashes.push(hashNext(hashes[hashes.length - 1], action));
    }
    return hashes;
}

// Board and page files as the server writes them
function writeBoard(dir, boardId, board) {
    fs.writeFileSync(path.join(dir, 'data', `${boardId}.board`), serialize(board));
}

function writePage(dir, pageId, history, present = history.length, hashes = chain(pageId, history)) {
    const page = { history, present, state: { visible: compileVisualState(history.slice(0, present)).visible }, hashes };
    fs.writeFileSync(path.join(dir, 'data', `${pageId}.page`), serialize(page));
}

const readFile = (dir, name) => deserialize(fs.readFileSync(path.join(dir, 'data', name), 'utf8'));

// A server that must refuse to start: its exit and output
async function refusedStart(dir) {
    await assert.rejects(startServer({ dir }), (error) => {
        assert.match(error.message, /server exited with 1 during startup/);
        return true;
    });
}

describe('persistence', () => {
    it('a restart keeps histories, undo positions, page orders and the deletion map', async () => {
        let server = await startServer({ users: [ANN] });
        try {
            let client = await server.connect();
            const b = await client.createBoard(ANN.login, ANN.credential, 'kept');
            await client.open(b.board);
            const actions = [draw(), draw(), draw()];
            for (const action of actions) {
                await client.propose(b.board, b.passwd, b.firstPage, action);
            }
            await client.propose(b.board, b.passwd, b.firstPage, undo(actions[2].uuid));
            const second = (await client.proposePageAction(b.board, b.passwd, b.firstPage, newPage()))['page-uuid'];
            const third = (await client.proposePageAction(b.board, b.passwd, second, newPage()))['page-uuid'];
            await client.proposePageAction(b.board, b.passwd, second, deletePage());
            await client.request({ type: 'shuffle-proposal', 'board-uuid': b.board, passwd: b.passwd, before: [b.firstPage, third], after: [third, b.firstPage] });

            await server.stop();
            server = await startServer({ dir: server.dir });
            client = await server.connect();

            assert.deepEqual((await client.boardInfo(b.board)).pages, [third, b.firstPage]);
            const page = await client.fullPage(b.board, b.firstPage);
            assert.deepEqual(page.history, actions);
            assert.equal(page.present, 2);
            assert.equal(page.hash, chain(b.firstPage, actions)[2]);
            // the deleted page still redirects
            const lost = await client.fullPage(b.board, second);
            assert.deepEqual([lost.type, lost['page-uuid']], ['page-lost', third]);
            assert.deepEqual(JSON.parse(fs.readFileSync(path.join(server.dir, 'data', 'to_be_removed.json'), 'utf8')), { [second]: third });
            // the state continues: the undone action can be redone, and the visible set is right
            await client.open(b.board, b.firstPage);
            assert.equal((await client.propose(b.board, b.passwd, b.firstPage, { type: 'redo', uuid: uuid(), targetActionUuid: actions[2].uuid })).type, 'accept');
            assert.equal((await client.propose(b.board, b.passwd, b.firstPage, { ...actions[0] })).type, 'decline');
            // no temporary files are left behind
            assert.deepEqual(fs.readdirSync(path.join(server.dir, 'data')).filter(name => name.endsWith('.tmp')), []);
        } finally {
            await server.stop();
            removeDir(server.dir);
        }
    });

    it('the periodic save writes changes within 10 s, so a crash after that loses nothing', async () => {
        let server = await startServer({ users: [ANN] });
        try {
            let client = await server.connect();
            const b = await client.createBoard(ANN.login, ANN.credential, 'periodic');
            await client.open(b.board);
            const action = draw();
            await client.propose(b.board, b.passwd, b.firstPage, action);
            const added = (await client.proposePageAction(b.board, b.passwd, b.firstPage, newPage()))['page-uuid'];
            await sleep(11000);
            assert.deepEqual(readFile(server.dir, `${b.firstPage}.page`).history, [action]);
            assert.deepEqual(readFile(server.dir, `${b.board}.board`).pageOrder, [b.firstPage, added]);
            await server.kill();
            server = await startServer({ dir: server.dir });
            client = await server.connect();
            assert.deepEqual((await client.fullPage(b.board, b.firstPage)).history, [action]);
            assert.deepEqual((await client.boardInfo(b.board)).pages, [b.firstPage, added]);
        } finally {
            await server.stop();
            removeDir(server.dir);
        }
    });

    it('a board from before ownership opens, and is listed for nobody', async () => {
        const { dir } = makeInstanceDir([ANN]);
        const board = uuid();
        const page = uuid();
        const action = draw();
        writeBoard(dir, board, { passwd: 'legacypasswd', pageOrder: [page] });
        writePage(dir, page, [action]);
        const server = await startServer({ dir });
        try {
            const client = await server.connect();
            const registered = await client.open(board);
            assert.equal(registered['page-uuid'], page);
            assert.deepEqual((await client.fullPage(board, page)).history, [action]);
            assert.equal((await client.propose(board, 'legacypasswd', page, draw())).type, 'accept');
            assert.deepEqual((await client.listBoards(ANN.login, ANN.credential)).boards, []);
        } finally {
            await server.stop();
            removeDir(dir);
        }
    });

    it('a hash chain from another hash function is rebuilt on load and written back', async () => {
        const { dir } = makeInstanceDir([ANN]);
        const board = uuid();
        const page = uuid();
        const actions = [draw(), draw()];
        writeBoard(dir, board, { passwd: 'legacypasswd', pageOrder: [page] });
        writePage(dir, page, actions, 2, ['old0', 'old1', 'old2']);
        const server = await startServer({ dir });
        try {
            const client = await server.connect();
            const full = await client.fullPage(board, page);
            assert.equal(full.hash, chain(page, actions)[2]);
            assert.deepEqual(readFile(dir, `${page}.page`).hashes, chain(page, actions));
        } finally {
            await server.stop();
            removeDir(dir);
        }
    });

    it('a server without a user file starts, and lets nobody in', async () => {
        const { dir } = makeInstanceDir([ANN]);
        fs.unlinkSync(path.join(dir, 'conf', 'users.json'));
        const server = await startServer({ dir });
        try {
            assert.match(server.output, /Nobody can log in: No user file/);
            const client = await server.connect();
            assert.equal((await client.listBoards(ANN.login, ANN.credential)).message, 'credential not accepted');
        } finally {
            await server.stop();
            removeDir(dir);
        }
    });
});

describe('inconsistent data: the server refuses to run on it', () => {
    const owner = uuid();
    const ownedBoard = (boardPath, extra = {}) => ({ passwd: 'abcdefghijkl', pageOrder: [uuid()], owner, path: boardPath, createdAt: 1, ...extra });

    const cases = [
        ['an empty board file', (dir) => fs.writeFileSync(path.join(dir, 'data', `${uuid()}.board`), '')],
        ['a malformed owner', (dir) => writeBoard(dir, uuid(), ownedBoard('a', { owner: 'not-a-uuid' }))],
        ['a path not in normal form', (dir) => writeBoard(dir, uuid(), ownedBoard('a//b'))],
        ['a missing creation time', (dir) => writeBoard(dir, uuid(), ownedBoard('a', { createdAt: undefined }))],
        ['two boards with one path', (dir) => { writeBoard(dir, uuid(), ownedBoard('same')); writeBoard(dir, uuid(), ownedBoard('same')); }],
        ['a board inside another board', (dir) => { writeBoard(dir, uuid(), ownedBoard('outer')); writeBoard(dir, uuid(), ownedBoard('outer/inner')); }]
    ];
    for (const [name, damage] of cases) {
        it(`does not start with ${name}`, async () => {
            const { dir } = makeInstanceDir();
            try {
                damage(dir);
                await refusedStart(dir);
            } finally {
                removeDir(dir);
            }
        });
    }

    it('the same path for two owners is fine', async () => {
        const { dir } = makeInstanceDir();
        writeBoard(dir, uuid(), { passwd: 'abcdefghijkl', pageOrder: [uuid()], owner: uuid(), path: 'same', createdAt: 1 });
        writeBoard(dir, uuid(), { passwd: 'abcdefghijkl', pageOrder: [uuid()], owner: uuid(), path: 'same', createdAt: 1 });
        const server = await startServer({ dir });
        await server.stop();
        removeDir(dir);
    });

    it('a page whose hash chain does not fit its history ends the server when it is used', async () => {
        const { dir } = makeInstanceDir();
        const board = uuid();
        const page = uuid();
        writeBoard(dir, board, { passwd: 'legacypasswd', pageOrder: [page] });
        writePage(dir, page, [draw(), draw()], 2, [hashAny(page)]);
        const server = await startServer({ dir });
        try {
            const client = await server.connect();
            client.send({ type: 'fullPage-requests', 'board-uuid': board, 'page-uuid': page, delta: 0, register: false, requestId: uuid() });
            assert.equal(await server.exited, 1);
            assert.match(server.output, /unusable hash chain on disk: 1 hashes for 2 actions/);
        } finally {
            await server.stop();
            removeDir(dir);
        }
    });
});
