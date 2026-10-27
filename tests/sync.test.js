'use strict';
// Drawing and synchronization: proposals, accept and decline, the replay broadcast,
// undo and redo, the hash chain, full pages, page info, replays and pings
// (protocol.md: mod-action-proposals, Action Broadcast, Hash Chain).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { uuid, startServer, removeDir, stroke, draw, erase, group, undo, redo } = require('./harness');
const { hashAny, hashNext, recent_snapshots, NULL_UUID } = require(path.join(__dirname, '..', 'shared.js'));

const ANN = { login: 'ann', credential: 'ann' };

// The replay broadcast of an accepted action carries the action's uuid as requestId
const replayOf = (action) => (message => message.type === 'replay' && message.requestId === action.uuid);

// The chain a client computes from a page's history
function chain(pageId, history) {
    const hashes = [hashAny(pageId)];
    for (const action of history) {
        hashes.push(hashNext(hashes[hashes.length - 1], action));
    }
    return hashes;
}

describe('drawing and synchronization', () => {
    let server;
    let alice;   // proposes
    let viewer;  // another connection on the same board

    before(async () => {
        server = await startServer({ users: [ANN] });
        alice = await server.connect();
        viewer = await server.connect();
    });
    after(async () => {
        await server.stop();
        removeDir(server.dir);
    });

    // A fresh board, both connections on its first page
    async function freshBoard() {
        const created = await alice.createBoard(ANN.login, ANN.credential, `board-${uuid()}`);
        await alice.open(created.board);
        await viewer.open(created.board);
        alice.drain();
        viewer.drain();
        return { ...created, page: created.firstPage };
    }

    describe('proposals', () => {
        it('an accepted draw: accept to the proposer, replay to the others', async () => {
            const b = await freshBoard();
            const action = draw();
            const accept = await alice.propose(b.board, b.passwd, b.page, action);
            const anchor = hashAny(b.page);
            const after = hashNext(anchor, action);
            assert.deepEqual(accept, {
                type: 'accept', 'page-uuid': b.page, 'action-index': 0, 'action-uuid': action.uuid,
                'before-hash': anchor, 'after-hash': after, pageNr: 1, totalPages: 1
            });
            const replay = await viewer.next(replayOf(action));
            assert.deepEqual(replay, {
                type: 'replay', 'page-uuid': b.page, beforeHash: anchor, afterHash: after, present: 1, currentHash: after,
                pageNr: 1, totalPages: 1, requestId: action.uuid, 'do-move': false, edits: [action]
            });
            assert.equal(await alice.receives(replayOf(action), 300), false, 'no replay to the proposer');
        });

        it('the replay reaches every connection on the board, whatever page it is on, and no other board', async () => {
            const b = await freshBoard();
            const elsewhere = await server.connect();
            const other = await alice.createBoard(ANN.login, ANN.credential, `other-${uuid()}`);
            await elsewhere.open(other.board);
            elsewhere.drain();
            const action = draw();
            await alice.propose(b.board, b.passwd, b.page, action);
            await viewer.next(replayOf(action));
            assert.equal(await elsewhere.receives(replayOf(action), 300), false);
            elsewhere.close();
        });

        it('before-hash is not checked', async () => {
            const b = await freshBoard();
            alice.send({ type: 'mod-action-proposals', passwd: b.passwd, 'board-uuid': b.board, 'page-uuid': b.page, payload: draw(), 'before-hash': 'nonsense' });
            assert.equal((await alice.next('accept')).type, 'accept');
        });

        it('declines a wrong password and a page of another board', async () => {
            const b = await freshBoard();
            const other = await alice.createBoard(ANN.login, ANN.credential, `other-${uuid()}`);
            const wrong = await alice.propose(b.board, 'wrongpasswd1', b.page, draw());
            assert.deepEqual([wrong.type, wrong.reason, wrong['page-uuid']], ['decline', 'unauthorized', b.page]);
            const otherPassword = await alice.propose(b.board, other.passwd, b.page, draw());
            assert.equal(otherPassword.reason, 'unauthorized');
            const foreign = await alice.propose(b.board, b.passwd, other.firstPage, draw());
            assert.equal(foreign.reason, 'page not on board');
            const unknown = await alice.propose(b.board, b.passwd, uuid(), draw());
            assert.equal(unknown.reason, 'page not on board');
            const page = await alice.fullPage(b.board, b.page);
            assert.deepEqual(page.history, []);
            const declined = new Set([wrong, otherPassword, foreign, unknown].map(answer => answer['action-uuid']));
            assert.equal(await viewer.receives(message => message.type === 'replay' && declined.has(message.requestId), 300), false);
        });

        it('a proposal for an unknown board is dropped', async () => {
            const action = draw();
            alice.send({ type: 'mod-action-proposals', passwd: 'x', 'board-uuid': uuid(), 'page-uuid': uuid(), payload: action });
            assert.equal(await alice.receives(message => message['action-uuid'] === action.uuid, 500), false);
        });

        it('declines a draw whose element is visible and an erase whose target is not', async () => {
            const b = await freshBoard();
            const a = draw();
            await alice.propose(b.board, b.passwd, b.page, a);
            const again = await alice.propose(b.board, b.passwd, b.page, { ...a });
            assert.deepEqual([again.type, again.reason], ['decline', 'cannot apply action to current visual state']);
            assert.equal((await alice.propose(b.board, b.passwd, b.page, erase(uuid()))).reason, 'cannot apply action to current visual state');
            assert.equal((await alice.propose(b.board, b.passwd, b.page, erase(a.uuid))).type, 'accept');
            assert.equal((await alice.propose(b.board, b.passwd, b.page, erase(a.uuid))).reason, 'cannot apply action to current visual state');
        });

        it('a group is applied whole or not at all', async () => {
            const b = await freshBoard();
            const a = draw();
            await alice.propose(b.board, b.passwd, b.page, a);
            const inner = draw();
            const bad = group([inner, erase(uuid())]);
            assert.equal((await alice.propose(b.board, b.passwd, b.page, bad)).type, 'decline');
            // nothing of it was applied: inner can still be drawn
            assert.equal((await alice.propose(b.board, b.passwd, b.page, group([inner, erase(a.uuid)]))).type, 'accept');
            // a draw nested in a group is an element of its own: it can be erased
            assert.equal((await alice.propose(b.board, b.passwd, b.page, erase(inner.uuid))).type, 'accept');
            // nested groups
            const deep = group([group([draw(), group([draw()])])]);
            assert.equal((await alice.propose(b.board, b.passwd, b.page, deep)).type, 'accept');
            const page = await alice.fullPage(b.board, b.page);
            assert.equal(page.history.length, 4);
        });

        it('a proposal that fails validation is dropped without a reply', async () => {
            const b = await freshBoard();
            const broken = draw(stroke());
            broken.stroke[11] = 99;
            alice.send({ type: 'mod-action-proposals', passwd: b.passwd, 'board-uuid': b.board, 'page-uuid': b.page, payload: broken });
            assert.equal(await alice.receives(message => message['action-uuid'] === broken.uuid, 500), false);
        });
    });

    describe('undo and redo', () => {
        it('undo only the immediate past, redo only the immediate future', async () => {
            const b = await freshBoard();
            const a = draw();
            const c = draw();
            assert.equal((await alice.propose(b.board, b.passwd, b.page, undo(a.uuid))).reason, 'can only undo the immediate past', 'nothing to undo');
            assert.equal((await alice.propose(b.board, b.passwd, b.page, redo(a.uuid))).reason, 'can only redo the immediate future', 'nothing to redo');
            await alice.propose(b.board, b.passwd, b.page, a);
            await alice.propose(b.board, b.passwd, b.page, c);
            assert.equal((await alice.propose(b.board, b.passwd, b.page, undo(a.uuid))).reason, 'can only undo the immediate past');
            const undone = await alice.propose(b.board, b.passwd, b.page, undo(c.uuid));
            assert.equal(undone.type, 'accept');
            const hashes = chain(b.page, [a, c]);
            assert.deepEqual([undone['action-index'], undone['before-hash'], undone['after-hash']], [0, hashes[0], hashes[1]]);
            assert.equal((await alice.propose(b.board, b.passwd, b.page, redo(a.uuid))).reason, 'can only redo the immediate future');
            const redone = await alice.propose(b.board, b.passwd, b.page, redo(c.uuid));
            assert.deepEqual([redone.type, redone['action-index'], redone['after-hash']], ['accept', 1, hashes[2]]);
        });

        it('the replay broadcast of an undo starts before the undone entry and carries the tail', async () => {
            const b = await freshBoard();
            const [a, c, d] = [draw(), draw(), draw()];
            for (const action of [a, c, d]) {
                await alice.propose(b.board, b.passwd, b.page, action);
            }
            const undoD = undo(d.uuid);
            await alice.propose(b.board, b.passwd, b.page, undoD);
            const hashes = chain(b.page, [a, c, d]);
            let replay = await viewer.next(replayOf(undoD));
            assert.deepEqual([replay.present, replay.currentHash, replay.beforeHash, replay.afterHash], [2, hashes[2], hashes[1], hashes[3]]);
            assert.deepEqual(replay.edits.map(edit => edit.uuid), [c.uuid, d.uuid]);
            const undoC = undo(c.uuid);
            await alice.propose(b.board, b.passwd, b.page, undoC);
            replay = await viewer.next(replayOf(undoC));
            assert.equal(replay.present, 1);
            assert.deepEqual(replay.edits.map(edit => edit.uuid), [a.uuid, c.uuid, d.uuid]);
            // the redo: the redone action and the rest of the tail
            const redoC = redo(c.uuid);
            await alice.propose(b.board, b.passwd, b.page, redoC);
            replay = await viewer.next(replayOf(redoC));
            assert.equal(replay.present, 2);
            assert.deepEqual(replay.edits.map(edit => edit.uuid), [c.uuid, d.uuid]);
        });

        it('undo of the first entry: the replay starts at position 0', async () => {
            const b = await freshBoard();
            const a = draw();
            await alice.propose(b.board, b.passwd, b.page, a);
            const undoA = undo(a.uuid);
            await alice.propose(b.board, b.passwd, b.page, undoA);
            const replay = await viewer.next(replayOf(undoA));
            assert.deepEqual([replay.present, replay.beforeHash, replay.currentHash], [0, hashAny(b.page), hashAny(b.page)]);
            assert.deepEqual(replay.edits.map(edit => edit.uuid), [a.uuid]);
        });

        it('undo makes an erased element visible again, and its redo hides it', async () => {
            const b = await freshBoard();
            const a = draw();
            const gone = erase(a.uuid);
            await alice.propose(b.board, b.passwd, b.page, a);
            await alice.propose(b.board, b.passwd, b.page, gone);
            await alice.propose(b.board, b.passwd, b.page, undo(gone.uuid));
            // a is visible again: drawing it again is declined, erasing it accepted
            assert.equal((await alice.propose(b.board, b.passwd, b.page, { ...a })).type, 'decline');
            const eraseAgain = erase(a.uuid);
            assert.equal((await alice.propose(b.board, b.passwd, b.page, eraseAgain)).type, 'accept');
        });

        it('a new edit discards the undone tail', async () => {
            const b = await freshBoard();
            const [a, c] = [draw(), draw()];
            await alice.propose(b.board, b.passwd, b.page, a);
            await alice.propose(b.board, b.passwd, b.page, c);
            await alice.propose(b.board, b.passwd, b.page, undo(c.uuid));
            const d = draw();
            const accept = await alice.propose(b.board, b.passwd, b.page, d);
            assert.equal(accept['action-index'], 1);
            assert.equal(accept['after-hash'], chain(b.page, [a, d])[2]);
            const page = await alice.fullPage(b.board, b.page);
            assert.deepEqual(page.history.map(edit => edit.uuid), [a.uuid, d.uuid]);
            assert.equal((await alice.propose(b.board, b.passwd, b.page, redo(c.uuid))).type, 'decline');
            // c's element is gone with the tail: it may be drawn anew
            assert.equal((await alice.propose(b.board, b.passwd, b.page, { ...c })).type, 'accept');
        });
    });

    describe('page state', () => {
        // a page with an undone tail: a, b, c with c undone
        async function pageWithTail() {
            const b = await freshBoard();
            const actions = [draw(), draw(), draw()];
            for (const action of actions) {
                await alice.propose(b.board, b.passwd, b.page, action);
            }
            await alice.propose(b.board, b.passwd, b.page, undo(actions[2].uuid));
            return { ...b, actions, hashes: chain(b.page, actions) };
        }

        it('fullPage: the whole history, undone tail included, present and its hash', async () => {
            const p = await pageWithTail();
            const page = await viewer.fullPage(p.board, p.page);
            assert.equal(page.type, 'fullPage');
            assert.deepEqual(page.history, p.actions);
            assert.deepEqual([page.present, page.hash, page.pageNr, page.totalPages, page['do-move']], [2, p.hashes[2], 1, 1, false]);
            // the chain the client computes from the history agrees with the server's
            assert.equal(chain(p.page, page.history)[page.present], page.hash);
        });

        it('page-info: the hash at present and the snapshots of the chain', async () => {
            const p = await pageWithTail();
            const info = await viewer.pageInfo(p.board, p.page);
            assert.equal(info.type, 'page-info');
            assert.equal(info.hash, p.hashes[2]);
            assert.deepEqual(info.snapshots, recent_snapshots(3).map(position => p.hashes[position]));
            const registered = await viewer.registerPage(p.board, p.page);
            assert.deepEqual([registered.type, registered.hash, registered.snapshots], ['page-registered', p.hashes[2], info.snapshots]);
        });

        it('replay-requests: the entries from a known position, or page-info on a mismatch', async () => {
            const p = await pageWithTail();
            const replay = await viewer.replay(p.board, p.page, 1, p.hashes[1]);
            assert.equal(replay.type, 'replay');
            assert.deepEqual(replay.edits, p.actions.slice(1));
            assert.deepEqual([replay.beforeHash, replay.present, replay.currentHash, replay.afterHash], [p.hashes[1], 2, p.hashes[2], p.hashes[2]]);
            const fromStart = await viewer.replay(p.board, p.page, 0, hashAny(p.page));
            assert.deepEqual(fromStart.edits, p.actions);
            const atEnd = await viewer.replay(p.board, p.page, 3, p.hashes[3]);
            assert.deepEqual(atEnd.edits, []);
            const mismatch = await viewer.replay(p.board, p.page, 1, p.hashes[2]);
            assert.deepEqual([mismatch.type, mismatch.hash], ['page-info', p.hashes[2]]);
            const beyond = await viewer.replay(p.board, p.page, 99, p.hashes[2]);
            assert.equal(beyond.type, 'page-info');
        });

        it('many actions: snapshots are the chain at recent_snapshots, and a client finds a common position', async () => {
            const b = await freshBoard();
            const actions = [];
            for (let i = 0; i < 40; ++i) {
                const action = draw(stroke([[i, i], [i + 1, i + 1]]));
                actions.push(action);
                await alice.propose(b.board, b.passwd, b.page, action);
            }
            const hashes = chain(b.page, actions);
            const info = await viewer.pageInfo(b.board, b.page);
            const positions = recent_snapshots(40);
            assert.deepEqual(info.snapshots, positions.map(position => hashes[position]));
            // a client that has the first 25 actions: the latest snapshot it shares
            const mine = hashes.slice(0, 26);
            const common = Math.max(...positions.filter(position => mine[position] === info.snapshots[positions.indexOf(position)]));
            const replay = await viewer.replay(b.board, b.page, common, mine[common]);
            assert.deepEqual(replay.edits, actions.slice(common));
        });
    });

    describe('registration', () => {
        it('register-board: the first page, or the page asked for', async () => {
            const b = await freshBoard();
            const registered = await viewer.registerBoard(b.board);
            assert.deepEqual(registered, {
                type: 'board-registered', 'board-uuid': b.board, 'first-page-uuid': b.page, 'last-page-uuid': b.page,
                totalPages: 1, requestId: registered.requestId
            });
            assert.equal((await viewer.registerBoard(b.board, b.page))['first-page-uuid'], b.page);
            // a page that is not on the board: the first page
            assert.equal((await viewer.registerBoard(b.board, uuid()))['first-page-uuid'], b.page);
        });

        it('register-board for an unknown board: no such board, with the requestId', async () => {
            const answer = await viewer.registerBoard(uuid());
            assert.deepEqual([answer.type, answer.message], ['error', 'no such board']);
        });

        it('requests for unknown boards are dropped', async () => {
            const board = uuid();
            const page = uuid();
            const requests = [
                { type: 'register-page', 'board-uuid': board, 'page-uuid': page },
                { type: 'page-info-request', 'board-uuid': board, 'page-uuid': page },
                { type: 'fullPage-requests', 'board-uuid': board, 'page-uuid': page, delta: 0, register: false },
                { type: 'replay-requests', 'board-uuid': board, 'page-uuid': page, present: 0, 'present-hash': 'x', register: false },
                { type: 'board-info-request', 'board-uuid': board }
            ];
            const ids = requests.map(request => {
                const requestId = uuid();
                viewer.send({ ...request, requestId });
                return requestId;
            });
            assert.equal(await viewer.receives(message => ids.includes(message.requestId), 500), false);
        });

        it('pings report the connection\'s page; board-info comes every 5 s, too', async () => {
            const b = await freshBoard();
            const a = draw();
            await alice.propose(b.board, b.passwd, b.page, a);
            const listener = await server.connect();
            await listener.open(b.board);
            listener.drain();
            const ping = await listener.next('ping', 7000);
            assert.deepEqual(ping, {
                type: 'ping', 'page-uuid': b.page, hash: chain(b.page, [a])[1], pageNr: 1, totalPages: 1,
                snapshots: [hashAny(b.page)]
            });
            const info = await listener.next(message => message.type === 'board-info' && message.requestId === NULL_UUID, 7000);
            assert.deepEqual(info.pages, [b.page]);
            listener.close();
        });

        it('a connection with no board gets no pings', async () => {
            const idle = await server.connect();
            assert.equal(await idle.receives(message => message.type === 'ping' || message.type === 'board-info', 5500), false);
            idle.close();
        });
    });

    describe('concurrent editing', () => {
        it('two connections drawing at once end with one history, the same for everybody', async () => {
            const b = await freshBoard();
            const bob = await server.connect();
            await bob.open(b.board);
            const mine = [];
            const theirs = [];
            const proposals = [];
            for (let i = 0; i < 20; ++i) {
                const ours = draw(stroke([[i, 0], [i, 1]]));
                const other = draw(stroke([[0, i], [1, i]]));
                mine.push(ours);
                theirs.push(other);
                proposals.push(alice.propose(b.board, b.passwd, b.page, ours), bob.propose(b.board, b.passwd, b.page, other));
            }
            const answers = await Promise.all(proposals);
            assert.ok(answers.every(answer => answer.type === 'accept'));
            const page = await viewer.fullPage(b.board, b.page);
            assert.equal(page.history.length, 40);
            assert.deepEqual(new Set(page.history.map(edit => edit.uuid)), new Set([...mine, ...theirs].map(edit => edit.uuid)));
            assert.equal(chain(b.page, page.history)[40], page.hash);
            // each accept names the position its action took
            for (const answer of answers) {
                assert.equal(page.history[answer['action-index']].uuid, answer['action-uuid']);
            }
            bob.close();
        });
    });
});
