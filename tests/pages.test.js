'use strict';
// Pages of a board: adding, deleting, the deletion map, reordering and navigation
// (protocol.md: Page Management Protocol, Shuffle Protocol, register-page).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { uuid, startServer, removeDir, draw, newPage, deletePage } = require('./harness');
const { deserialize, hashAny, NULL_UUID } = require(path.join(__dirname, '..', 'shared.js'));

const ANN = { login: 'ann', credential: 'ann' };

describe('pages', () => {
    let server;
    let alice;
    let viewer;

    before(async () => {
        server = await startServer({ users: [ANN] });
        alice = await server.connect();
        viewer = await server.connect();
    });
    after(async () => {
        await server.stop();
        removeDir(server.dir);
    });

    const pageOrder = async (board) => (await viewer.boardInfo(board)).pages;
    const boardFile = (board) => deserialize(fs.readFileSync(path.join(server.dir, 'data', `${board}.board`), 'utf8'));

    // A board with n pages, alice on the first
    async function boardWithPages(n) {
        const created = await alice.createBoard(ANN.login, ANN.credential, `pages-${uuid()}`);
        await alice.open(created.board);
        let last = created.firstPage;
        for (let i = 1; i < n; ++i) {
            last = (await alice.proposePageAction(created.board, created.passwd, last, newPage()))['page-uuid'];
        }
        const pages = await pageOrder(created.board);
        assert.equal(pages.length, n);
        alice.drain();
        return { board: created.board, passwd: created.passwd, pages };
    }

    describe('adding a page', () => {
        it('inserts an empty page after the named one and moves the proposer there', async () => {
            const b = await boardWithPages(2);
            await viewer.open(b.board, b.pages[0]);
            viewer.drain();
            const action = newPage();
            const full = await alice.proposePageAction(b.board, b.passwd, b.pages[0], action);
            assert.equal(full.type, 'fullPage');
            assert.equal(full['do-move'], true);
            assert.deepEqual(full.history, []);
            assert.deepEqual([full.present, full.hash, full.pageNr, full.totalPages], [0, hashAny(full['page-uuid']), 2, 3]);
            assert.deepEqual(await pageOrder(b.board), [b.pages[0], full['page-uuid'], b.pages[1]]);
            // the others get a ping and the new page order
            const info = await viewer.next(message => message.type === 'board-info' && message.requestId === action.uuid);
            assert.deepEqual(info.pages, [b.pages[0], full['page-uuid'], b.pages[1]]);
            const ping = await viewer.next('ping');
            assert.deepEqual([ping['page-uuid'], ping.pageNr, ping.totalPages], [b.pages[0], 1, 3]);
            // the proposer is on the new page now: its ping says so
            const own = await alice.next('ping');
            assert.equal(own['page-uuid'], full['page-uuid']);
            assert.ok(fs.existsSync(path.join(server.dir, 'data', `${full['page-uuid']}.page`)));
        });

        it('without a requestId in the proposal, as the client sends it, the answers carry N/A', async () => {
            const b = await boardWithPages(1);
            alice.send({ type: 'mod-action-proposals', passwd: b.passwd, 'board-uuid': b.board, 'page-uuid': b.pages[0], payload: newPage(), 'before-hash': NULL_UUID });
            const full = await alice.next('fullPage');
            assert.deepEqual([full.requestId, full['do-move'], full.pageNr], ['N/A', true, 2]);
            assert.equal((await alice.next(message => message.type === 'board-info' && message.requestId === 'N/A')).pages.length, 2);
        });

        it('a page action with a wrong password or a foreign page is declined', async () => {
            const b = await boardWithPages(1);
            const wrong = newPage();
            assert.equal((await alice.propose(b.board, 'wrongpasswd1', b.pages[0], wrong)).reason, 'unauthorized');
            assert.equal((await alice.propose(b.board, b.passwd, uuid(), deletePage())).reason, 'page not on board');
            assert.deepEqual(await pageOrder(b.board), b.pages);
        });
    });

    describe('deleting a page', () => {
        it('the page at its position replaces it; viewers on it are moved', async () => {
            const b = await boardWithPages(3);
            await viewer.open(b.board, b.pages[1]);
            viewer.drain();
            const action = deletePage();
            const info = await alice.proposePageAction(b.board, b.passwd, b.pages[1], action);
            assert.deepEqual([info.type, info['page-uuid'], info['do-move'], info.pageNr, info.totalPages], ['page-info', b.pages[2], true, 2, 2]);
            assert.deepEqual(await pageOrder(b.board), [b.pages[0], b.pages[2]]);
            const ping = await viewer.next('ping');
            assert.deepEqual([ping['page-uuid'], ping.pageNr, ping.totalPages], [b.pages[2], 2, 2]);
            const order = await viewer.next(message => message.type === 'board-info' && message.requestId === action.uuid);
            assert.deepEqual(order.pages, [b.pages[0], b.pages[2]]);
            // the page file stays on disk
            assert.ok(fs.existsSync(path.join(server.dir, 'data', `${b.pages[1]}.page`)));
        });

        it('deleting the last page: the new last page replaces it', async () => {
            const b = await boardWithPages(3);
            const info = await alice.proposePageAction(b.board, b.passwd, b.pages[2], deletePage());
            assert.deepEqual([info['page-uuid'], info.pageNr, info.totalPages], [b.pages[1], 2, 2]);
        });

        it('deleting the only page: a new empty page takes its place', async () => {
            const b = await boardWithPages(1);
            const a = draw();
            await alice.propose(b.board, b.passwd, b.pages[0], a);
            const full = await alice.proposePageAction(b.board, b.passwd, b.pages[0], deletePage());
            assert.equal(full.type, 'fullPage');
            assert.notEqual(full['page-uuid'], b.pages[0]);
            assert.deepEqual([full.history, full.present, full['do-move'], full.totalPages], [[], 0, true, 1]);
            assert.deepEqual(await pageOrder(b.board), [full['page-uuid']]);
        });
    });

    describe('the deletion map', () => {
        it('every request for a deleted page is redirected to its replacement', async () => {
            const b = await boardWithPages(3);
            await alice.proposePageAction(b.board, b.passwd, b.pages[1], deletePage());
            const lost = b.pages[1];
            const replacement = b.pages[2];

            const full = await viewer.fullPage(b.board, lost);
            assert.deepEqual([full.type, full['lost-uuid'], full['page-uuid'], full.pageNr, full.totalPages], ['page-lost', lost, replacement, 2, 2]);
            // with a delta, the move starts from the replacement
            assert.equal((await viewer.fullPage(b.board, lost, -1)).type, 'fullPage');
            assert.equal((await viewer.fullPage(b.board, lost, -1))['page-uuid'], b.pages[0]);
            const info = await viewer.pageInfo(b.board, lost);
            assert.deepEqual([info.type, info['page-uuid']], ['page-info', replacement]);
            const registered = await viewer.registerPage(b.board, lost);
            assert.deepEqual([registered.type, registered['page-uuid']], ['page-registered', replacement]);
            assert.equal((await viewer.registerBoard(b.board, lost))['first-page-uuid'], replacement);
            const replay = await viewer.replay(b.board, lost, 0, hashAny(lost));
            assert.deepEqual([replay.type, replay['page-uuid']], ['page-lost', replacement]);
        });

        it('chains of deletions are followed', async () => {
            const b = await boardWithPages(4);
            await alice.proposePageAction(b.board, b.passwd, b.pages[1], deletePage()); // 1 -> 2
            await alice.proposePageAction(b.board, b.passwd, b.pages[2], deletePage()); // 2 -> 3
            assert.equal((await viewer.pageInfo(b.board, b.pages[1]))['page-uuid'], b.pages[3]);
        });

        it('a replacement that is gone from the board falls back to the first page', async () => {
            const b = await boardWithPages(2);
            // 1 -> 0 (the new last page), then 0 -> 1? no: delete 1, then 0 is the only page;
            // deleting it puts a fresh page in its place, and 1 resolves through 0 to it
            await alice.proposePageAction(b.board, b.passwd, b.pages[1], deletePage());
            const full = await alice.proposePageAction(b.board, b.passwd, b.pages[0], deletePage());
            assert.equal((await viewer.pageInfo(b.board, b.pages[1]))['page-uuid'], full['page-uuid']);
            // a page id the map has never seen: the first page
            assert.equal((await viewer.pageInfo(b.board, uuid()))['page-uuid'], full['page-uuid']);
        });
    });

    describe('navigation', () => {
        it('register-page and page-info move by delta, clamped to the first and last page', async () => {
            const b = await boardWithPages(3);
            const cases = [[0, 1, 1], [0, -1, 0], [0, 5, 2], [2, 1, 2], [2, -2, 0], [1, 0, 1]];
            for (const [from, delta, to] of cases) {
                const registered = await viewer.registerPage(b.board, b.pages[from], delta);
                assert.deepEqual([registered['page-uuid'], registered.pageNr, registered.totalPages], [b.pages[to], to + 1, 3], `${from}${delta}`);
                assert.equal((await viewer.pageInfo(b.board, b.pages[from], delta))['page-uuid'], b.pages[to]);
                assert.equal((await viewer.fullPage(b.board, b.pages[from], delta))['page-uuid'], b.pages[to]);
            }
        });

        it('register moves the connection: its pings follow', async () => {
            const b = await boardWithPages(3);
            const mover = await server.connect();
            await mover.open(b.board);
            await mover.pageInfo(b.board, b.pages[0], 2, true);
            mover.drain();
            assert.equal((await mover.next('ping', 7000))['page-uuid'], b.pages[2]);
            await mover.fullPage(b.board, b.pages[2], -1, true);
            mover.drain();
            assert.equal((await mover.next('ping', 7000))['page-uuid'], b.pages[1]);
            // without register, the connection stays
            await mover.pageInfo(b.board, b.pages[0], 0, false);
            await mover.fullPage(b.board, b.pages[0], 0, false);
            mover.drain();
            assert.equal((await mover.next('ping', 7000))['page-uuid'], b.pages[1]);
            mover.close();
        });

        it('board-info with register: the board\'s first page', async () => {
            const b = await boardWithPages(2);
            const mover = await server.connect();
            const info = await mover.boardInfo(b.board, true);
            assert.deepEqual(info.pages, b.pages);
            assert.equal((await mover.next('ping', 7000))['page-uuid'], b.pages[0]);
            mover.close();
        });
    });

    describe('reordering (shuffle)', () => {
        const shuffle = (client, b, before, after, passwd = b.passwd) =>
            client.request({ type: 'shuffle-proposal', 'board-uuid': b.board, passwd, before, after });

        it('a permutation is saved and broadcast to everybody on the board', async () => {
            const b = await boardWithPages(3);
            await viewer.open(b.board);
            const reordered = [b.pages[2], b.pages[0], b.pages[1]];
            const answer = await shuffle(alice, b, b.pages, reordered);
            assert.deepEqual([answer.type, answer.pages], ['board-info', reordered]);
            const seen = await viewer.next(message => message.requestId === answer.requestId);
            assert.deepEqual(seen.pages, reordered);
            assert.deepEqual(boardFile(b.board).pageOrder, reordered);
            // page numbers follow the new order
            assert.equal((await viewer.pageInfo(b.board, b.pages[2])).pageNr, 1);
        });

        it('anything else gets the unchanged order, to the proposer only', async () => {
            const b = await boardWithPages(3);
            await viewer.open(b.board);
            viewer.drain();
            const [p0, p1, p2] = b.pages;
            const refused = [
                [b.pages, [p1, p0, p2], 'wrongpasswd1'],
                [[p1, p0, p2], [p0, p1, p2]],           // out of sync
                [b.pages, [p0, p1]],                    // shorter
                [b.pages, [p0, p0, p1]],                // not a permutation
                [b.pages, [p0, p1, uuid()]]             // a foreign page
            ];
            for (const [before, after, passwd] of refused) {
                const answer = await shuffle(alice, b, before, after, passwd);
                assert.deepEqual([answer.type, answer.pages], ['board-info', b.pages], JSON.stringify(after));
                assert.equal(await viewer.receives(message => message.requestId === answer.requestId, 200), false);
            }
            assert.deepEqual(await pageOrder(b.board), b.pages);
        });

        it('a shuffle from a connection not on the board is dropped', async () => {
            const b = await boardWithPages(2);
            const outsider = await server.connect();
            const requestId = uuid();
            outsider.send({ type: 'shuffle-proposal', 'board-uuid': b.board, passwd: b.passwd, before: b.pages, after: [b.pages[1], b.pages[0]], requestId });
            assert.equal(await outsider.receives(message => message.requestId === requestId, 500), false);
            assert.deepEqual(await pageOrder(b.board), b.pages);
            outsider.close();
        });
    });
});
