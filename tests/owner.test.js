'use strict';
// Owner messages: credentials, the user file read for every check, board creation,
// the board list, and moving boards and folders (protocol.md, "Owner messages").

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { uuid, sleep, startServer, removeDir, readUsers, writeUsers, draw } = require('./harness');
const { hashPassword } = require(path.join(__dirname, '..', 'users.js'));
const { deserialize } = require(path.join(__dirname, '..', 'shared.js'));

const ANN = { login: 'ann', credential: 'ann has a credential' };
const BOB = { login: 'bob', credential: ' bob  with spaces ' };

const notRoot = process.getuid && process.getuid() === 0 ? 'root writes anything' : false;

describe('owner messages', () => {
    let server;
    let client;

    before(async () => {
        server = await startServer({ users: [ANN, BOB] });
        client = await server.connect();
    });
    after(async () => {
        await server.stop();
        removeDir(server.dir);
    });

    const boardFile = (board) => deserialize(fs.readFileSync(path.join(server.dir, 'data', `${board}.board`), 'utf8'));
    const paths = (list) => list.boards.map(entry => entry.path);

    describe('credentials', () => {
        it('a matching login and credential gets the board list', async () => {
            const answer = await client.listBoards(ANN.login, ANN.credential);
            assert.equal(answer.type, 'board-list');
            assert.ok(Array.isArray(answer.boards));
        });

        it('a wrong credential and an unknown login get the same refusal', async () => {
            for (const [login, credential] of [[ANN.login, 'wrong'], ['nobody', ANN.credential], [ANN.login, BOB.credential]]) {
                const answer = await client.listBoards(login, credential);
                assert.deepEqual([answer.type, answer.message], ['error', 'credential not accepted'], `${login} / ${credential}`);
            }
        });

        it('the credential is taken exactly as typed: no trimming', async () => {
            assert.equal((await client.listBoards(BOB.login, BOB.credential)).type, 'board-list');
            assert.equal((await client.listBoards(BOB.login, BOB.credential.trim())).message, 'credential not accepted');
            assert.equal((await client.listBoards(BOB.login.toUpperCase(), BOB.credential)).message, 'credential not accepted');
        });

        it('no login state: every connection and every message is checked on its own', async () => {
            const other = await server.connect();
            assert.equal((await other.listBoards(ANN.login, ANN.credential)).type, 'board-list');
            assert.equal((await other.listBoards(ANN.login, 'wrong')).message, 'credential not accepted');
            // a good message before does not let a bad one through
            assert.equal((await other.owner('create-board', ANN.login, 'wrong', { path: 'never' })).message, 'credential not accepted');
            other.close();
        });

        it('one check per connection at a time', async () => {
            const first = uuid();
            const second = uuid();
            client.send({ type: 'list-boards', login: ANN.login, passwd: ANN.credential, requestId: first });
            client.send({ type: 'list-boards', login: ANN.login, passwd: ANN.credential, requestId: second });
            const refused = await client.next(message => message.requestId === second);
            assert.deepEqual([refused.type, refused.message], ['error', 'a credential is already being checked']);
            assert.equal((await client.next(message => message.requestId === first)).type, 'board-list');
            // another connection is not held up
            const other = await server.connect();
            const third = uuid();
            client.send({ type: 'list-boards', login: ANN.login, passwd: ANN.credential, requestId: third });
            assert.equal((await other.listBoards(ANN.login, ANN.credential)).type, 'board-list');
            assert.equal((await client.next(message => message.requestId === third)).type, 'board-list');
            other.close();
        });

        it('owner messages that fail validation are dropped without a reply', async () => {
            const requestId = uuid();
            client.send({ type: 'list-boards', login: ANN.login, requestId });
            client.send({ type: 'list-boards', login: 'x'.repeat(65), passwd: ANN.credential, requestId });
            client.send({ type: 'list-boards', login: ANN.login, passwd: ANN.credential });
            client.send({ type: 'create-board', login: ANN.login, passwd: ANN.credential, path: 7, requestId });
            assert.equal(await client.receives(message => message.requestId === requestId, 500), false);
        });
    });

    describe('the user file, read for every check', () => {
        it('a user the admin adds while the server runs can log in at once, a removed one cannot', async () => {
            const carol = { id: uuid(), login: 'carol', hash: hashPassword('carol') };
            const entries = readUsers(server.dir);
            writeUsers(server.dir, [...entries, carol]);
            assert.equal((await client.listBoards('carol', 'carol')).type, 'board-list');
            writeUsers(server.dir, entries);
            assert.equal((await client.listBoards('carol', 'carol')).message, 'credential not accepted');
        });

        it('a credential the admin changes on disk counts at once', async () => {
            const entries = readUsers(server.dir);
            const changed = entries.map(entry => entry.login === ANN.login ? { ...entry, hash: hashPassword('changed by admin') } : entry);
            writeUsers(server.dir, changed);
            try {
                assert.equal((await client.listBoards(ANN.login, ANN.credential)).message, 'credential not accepted');
                assert.equal((await client.listBoards(ANN.login, 'changed by admin')).type, 'board-list');
            } finally {
                writeUsers(server.dir, entries);
            }
        });

        it('an invalid or missing user file lets nobody in, and the server keeps running', async () => {
            const file = path.join(server.dir, 'conf', 'users.json');
            const text = fs.readFileSync(file, 'utf8');
            try {
                fs.writeFileSync(file, 'not json');
                assert.equal((await client.listBoards(ANN.login, ANN.credential)).message, 'credential not accepted');
                fs.unlinkSync(file);
                assert.equal((await client.listBoards(ANN.login, ANN.credential)).message, 'credential not accepted');
            } finally {
                fs.writeFileSync(file, text, { mode: 0o600 });
            }
            assert.equal((await client.listBoards(ANN.login, ANN.credential)).type, 'board-list');
            assert.ok(server.running);
        });
    });

    describe('change-credential', () => {
        it('replaces only this user\'s hash, keeps what is on disk, and writes mode 600', async () => {
            // an entry with an extra field, and one the admin added after the start
            const dave = { id: uuid(), login: 'dave', hash: hashPassword('dave'), note: 'added later' };
            const before = readUsers(server.dir);
            writeUsers(server.dir, [...before, dave]);
            fs.chmodSync(path.join(server.dir, 'conf', 'users.json'), 0o644);

            const answer = await client.owner('change-credential', BOB.login, BOB.credential, { 'new-passwd': ' new  credential ' });
            assert.equal(answer.type, 'credential-changed');

            const after = readUsers(server.dir);
            assert.equal(after.length, before.length + 1);
            assert.deepEqual(after.find(entry => entry.login === 'dave'), dave);
            assert.deepEqual(after.find(entry => entry.login === ANN.login), before.find(entry => entry.login === ANN.login));
            const bobBefore = before.find(entry => entry.login === BOB.login);
            const bobAfter = after.find(entry => entry.login === BOB.login);
            assert.equal(bobAfter.id, bobBefore.id);
            assert.notEqual(bobAfter.hash, bobBefore.hash);
            assert.equal(fs.statSync(path.join(server.dir, 'conf', 'users.json')).mode & 0o777, 0o600);
            assert.equal(fs.existsSync(path.join(server.dir, 'conf', 'users.json.tmp')), false);

            assert.equal((await client.listBoards(BOB.login, BOB.credential)).message, 'credential not accepted');
            assert.equal((await client.listBoards(BOB.login, ' new  credential ')).type, 'board-list');
            // and back
            assert.equal((await client.owner('change-credential', BOB.login, ' new  credential ', { 'new-passwd': BOB.credential })).type, 'credential-changed');
            assert.equal((await client.listBoards(BOB.login, BOB.credential)).type, 'board-list');
        });

        it('a wrong current credential changes nothing', async () => {
            const before = fs.readFileSync(path.join(server.dir, 'conf', 'users.json'), 'utf8');
            const answer = await client.owner('change-credential', ANN.login, 'wrong', { 'new-passwd': 'x' });
            assert.equal(answer.message, 'credential not accepted');
            assert.equal(fs.readFileSync(path.join(server.dir, 'conf', 'users.json'), 'utf8'), before);
        });

        it('a user file that cannot be written: refused, and the old credential stays valid', { skip: notRoot }, async () => {
            const conf = path.join(server.dir, 'conf');
            const before = fs.readFileSync(path.join(conf, 'users.json'), 'utf8');
            fs.chmodSync(conf, 0o500);
            try {
                const answer = await client.owner('change-credential', ANN.login, ANN.credential, { 'new-passwd': 'x' });
                assert.deepEqual([answer.type, answer.message], ['error', 'credential could not be saved']);
            } finally {
                fs.chmodSync(conf, 0o700);
            }
            assert.equal(fs.readFileSync(path.join(conf, 'users.json'), 'utf8'), before);
            assert.equal((await client.listBoards(ANN.login, ANN.credential)).type, 'board-list');
        });

    });

    describe('create-board', () => {
        it('creates a board for its owner, without opening it', async () => {
            const watcher = await server.connect();
            const home = await watcher.createBoard(ANN.login, ANN.credential, 'home');
            await watcher.open(home.board);

            const created = await watcher.createBoard(ANN.login, ANN.credential, 'teaching/algebra/week1');
            assert.match(created.passwd, /^[0-9a-z]{12}$/);
            assert.notEqual(created.board, home.board);

            // the connection is still on its board: it sees another client's stroke there
            const drawer = await server.connect();
            await drawer.open(home.board);
            watcher.drain();
            assert.equal((await drawer.propose(home.board, home.passwd, home.firstPage, draw())).type, 'accept');
            const replay = await watcher.next('replay');
            assert.equal(replay['page-uuid'], home.firstPage);

            // the board file records owner, path and creation time
            const file = boardFile(created.board);
            const ann = readUsers(server.dir).find(entry => entry.login === ANN.login);
            assert.equal(file.owner, ann.id);
            assert.equal(file.path, 'teaching/algebra/week1');
            assert.equal(file.passwd, created.passwd);
            assert.deepEqual(file.pageOrder, [created.firstPage]);
            assert.ok(Math.abs(file.createdAt - Date.now()) < 60000);
            assert.ok(fs.existsSync(path.join(server.dir, 'data', `${created.firstPage}.page`)));

            // the new board can be opened, and is empty
            const opened = await drawer.open(created.board);
            assert.equal(opened.type, 'page-registered');
            assert.equal(opened['page-uuid'], created.firstPage);
            assert.deepEqual([opened.pageNr, opened.totalPages], [1, 1]);
            const full = await drawer.fullPage(created.board, created.firstPage);
            assert.deepEqual(full.history, []);
            watcher.close();
            drawer.close();
        });

        it('refuses a path not in normal form, and does not clean it up', async () => {
            for (const bad of ['', ' a', 'a ', '/a', 'a/', 'a//b', '///', ' a // b ', 'a\tb', 'x'.repeat(257)]) {
                const answer = await client.owner('create-board', ANN.login, ANN.credential, { path: bad });
                assert.deepEqual([answer.type, answer.message], ['error', 'invalid path'], JSON.stringify(bad));
            }
            const list = await client.listBoards(ANN.login, ANN.credential);
            assert.ok(!paths(list).includes('a'));
            assert.ok(!paths(list).includes('a/b'));
        });

        it('refuses a path that is taken, or would put a board inside a board', async () => {
            await client.createBoard(ANN.login, ANN.credential, 'taken/board');
            for (const bad of ['taken/board', 'taken', 'taken/board/inside']) {
                const answer = await client.owner('create-board', ANN.login, ANN.credential, { path: bad });
                assert.deepEqual([answer.type, answer.message], ['error', 'path taken'], bad);
            }
            // another board in the same folder is fine
            await client.createBoard(ANN.login, ANN.credential, 'taken/other');
        });

        it('paths are per owner', async () => {
            await client.createBoard(ANN.login, ANN.credential, 'shared name');
            await client.createBoard(BOB.login, BOB.credential, 'shared name');
            const annList = await client.listBoards(ANN.login, ANN.credential);
            const bobList = await client.listBoards(BOB.login, BOB.credential);
            assert.ok(paths(annList).includes('shared name'));
            assert.deepEqual(paths(bobList), ['shared name']);
            const annEntry = annList.boards.find(entry => entry.path === 'shared name');
            assert.notEqual(annEntry['board-uuid'], bobList.boards[0]['board-uuid']);
        });

        it('the board list is sorted by path and has id, path, edit password and creation time', async () => {
            for (const name of ['sort/c', 'sort/a', 'sort/b']) {
                await client.createBoard(ANN.login, ANN.credential, name);
            }
            const list = await client.listBoards(ANN.login, ANN.credential);
            assert.deepEqual(paths(list), [...paths(list)].sort());
            for (const entry of list.boards) {
                assert.deepEqual(Object.keys(entry).sort(), ['board-uuid', 'createdAt', 'passwd', 'path']);
                assert.equal(boardFile(entry['board-uuid']).passwd, entry.passwd);
            }
        });

        it('owner and path never reach a board\'s other users', async () => {
            const created = await client.createBoard(ANN.login, ANN.credential, 'secret/path name');
            const visitor = await server.connect();
            const texts = [];
            visitor.ws.on('message', text => texts.push(text.toString()));
            await visitor.open(created.board);
            await visitor.boardInfo(created.board);
            await visitor.fullPage(created.board, created.firstPage);
            await visitor.pageInfo(created.board, created.firstPage);
            const ann = readUsers(server.dir).find(entry => entry.login === ANN.login);
            for (const text of texts) {
                assert.ok(!text.includes('secret/path name'), text);
                assert.ok(!text.includes(ann.id), text);
            }
            visitor.close();
        });
    });

    describe('set-path', () => {
        it('renames and moves a board, on disk too', async () => {
            const created = await client.createBoard(ANN.login, ANN.credential, 'move/me');
            const answer = await client.owner('set-path', ANN.login, ANN.credential, { 'board-uuid': created.board, path: 'moved/here' });
            assert.equal(answer.type, 'board-list');
            assert.ok(paths(answer).includes('moved/here'));
            assert.ok(!paths(answer).includes('move/me'));
            assert.equal(boardFile(created.board).path, 'moved/here');
            // the same path again: no change, the list all the same
            const same = await client.owner('set-path', ANN.login, ANN.credential, { 'board-uuid': created.board, path: 'moved/here' });
            assert.equal(same.type, 'board-list');
        });

        it('refuses another owner\'s board, an unknown board, invalid and taken paths', async () => {
            const anns = await client.createBoard(ANN.login, ANN.credential, 'set/one');
            await client.createBoard(ANN.login, ANN.credential, 'set/two');
            const bobs = await client.createBoard(BOB.login, BOB.credential, 'set/bob');
            const cases = [
                [BOB, anns.board, 'stolen', 'not your board'],
                [ANN, bobs.board, 'stolen', 'not your board'],
                [ANN, uuid(), 'nowhere', 'not your board'],
                [ANN, anns.board, 'set/', 'invalid path'],
                [ANN, anns.board, ' set/x', 'invalid path'],
                [ANN, anns.board, 'set/two', 'path taken'],
                [ANN, anns.board, 'set', 'path taken'],
                [ANN, anns.board, 'set/two/inside', 'path taken']
            ];
            for (const [user, board, target, reason] of cases) {
                const answer = await client.owner('set-path', user.login, user.credential, { 'board-uuid': board, path: target });
                assert.deepEqual([answer.type, answer.message], ['error', reason], `${user.login} ${target}`);
            }
            assert.equal(boardFile(anns.board).path, 'set/one');
            assert.equal(boardFile(bobs.board).path, 'set/bob');
        });

        it('the only board of a folder may take the folder\'s name', async () => {
            const created = await client.createBoard(ANN.login, ANN.credential, 'lonely/board');
            const answer = await client.owner('set-path', ANN.login, ANN.credential, { 'board-uuid': created.board, path: 'lonely' });
            assert.equal(answer.type, 'board-list');
            assert.equal(boardFile(created.board).path, 'lonely');
        });
    });

    describe('rename-prefix', () => {
        it('moves every board below a folder, on disk too', async () => {
            const a = await client.createBoard(ANN.login, ANN.credential, 'folder/a');
            const b = await client.createBoard(ANN.login, ANN.credential, 'folder/sub/b');
            const outside = await client.createBoard(ANN.login, ANN.credential, 'folderish');
            const answer = await client.owner('rename-prefix', ANN.login, ANN.credential, { from: 'folder', to: 'renamed/deeper' });
            assert.equal(answer.type, 'board-list');
            assert.equal(boardFile(a.board).path, 'renamed/deeper/a');
            assert.equal(boardFile(b.board).path, 'renamed/deeper/sub/b');
            assert.equal(boardFile(outside.board).path, 'folderish');
            assert.ok(!paths(answer).some(entry => entry.startsWith('folder/')));
        });

        it('moves a folder into its own subfolder', async () => {
            const a = await client.createBoard(ANN.login, ANN.credential, 'nest/a/x');
            const b = await client.createBoard(ANN.login, ANN.credential, 'nest/x');
            const answer = await client.owner('rename-prefix', ANN.login, ANN.credential, { from: 'nest', to: 'nest/a' });
            assert.equal(answer.type, 'board-list');
            assert.equal(boardFile(a.board).path, 'nest/a/a/x');
            assert.equal(boardFile(b.board).path, 'nest/a/x');
        });

        it('merges into an existing folder unless paths collide', async () => {
            const a = await client.createBoard(ANN.login, ANN.credential, 'merge-from/a');
            await client.createBoard(ANN.login, ANN.credential, 'merge-to/b');
            assert.equal((await client.owner('rename-prefix', ANN.login, ANN.credential, { from: 'merge-from', to: 'merge-to' })).type, 'board-list');
            assert.equal(boardFile(a.board).path, 'merge-to/a');

            const c = await client.createBoard(ANN.login, ANN.credential, 'clash-from/b');
            await client.createBoard(ANN.login, ANN.credential, 'clash-to/b');
            const answer = await client.owner('rename-prefix', ANN.login, ANN.credential, { from: 'clash-from', to: 'clash-to' });
            assert.deepEqual([answer.type, answer.message], ['error', 'path taken']);
            assert.equal(boardFile(c.board).path, 'clash-from/b');
        });

        it('refuses an unknown folder, a board as folder, invalid and too long paths', async () => {
            await client.createBoard(ANN.login, ANN.credential, 'refuse/board');
            await client.createBoard(ANN.login, ANN.credential, 'refuse-target');
            const cases = [
                ['no-such-folder', 'x', 'no such folder'],
                ['refuse/board', 'x', 'no such folder'],
                ['refuse/', 'x', 'invalid path'],
                ['refuse', ' x', 'invalid path'],
                ['refuse', 'x'.repeat(251), 'invalid path'], // x...x/board: 257 characters,
                ['refuse', 'refuse-target', 'path taken'] // refuse-target/board would lie inside a board
            ];
            for (const [from, to, reason] of cases) {
                const answer = await client.owner('rename-prefix', ANN.login, ANN.credential, { from, to });
                assert.deepEqual([answer.type, answer.message], ['error', reason], `${from} -> ${to}`);
            }
            // another owner's folder is no folder of this one
            const answer = await client.owner('rename-prefix', BOB.login, BOB.credential, { from: 'refuse', to: 'mine' });
            assert.equal(answer.message, 'no such folder');
        });
    });

    describe('after a restart', () => {
        it('the board index is rebuilt from the board files', async () => {
            const before = await client.listBoards(ANN.login, ANN.credential);
            await server.stop();
            await sleep(100);
            server = await startServer({ dir: server.dir });
            client = await server.connect();
            const after = await client.listBoards(ANN.login, ANN.credential);
            assert.deepEqual(after.boards, before.boards);
        });
    });
});
