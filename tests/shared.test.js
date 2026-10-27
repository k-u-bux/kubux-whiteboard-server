'use strict';
// shared.js on its own: path rules, snapshots, hashing, serialization, validation and
// the visual state, i.e. the code client and server have in common.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const shared = require(path.join(__dirname, '..', 'shared.js'));
const { uuid, stroke, draw, erase, group, undo, redo, newPage, deletePage } = require('./harness');

const {
    PATH_FORM, PATH_INVALID, PATH_TAKEN, NO_SUCH_FOLDER, MAX_PATH_LENGTH,
    pathFormProblem, findPathConflict, newBoardProblem, boardMoveProblem, folderMove
} = shared;

describe('path normal form (pathFormProblem)', () => {
    it('accepts paths in normal form', () => {
        for (const good of ['a', 'teaching/algebra/week1', 'a b/c d', '2026-10-05/01', 'ü/日本', 'x'.repeat(MAX_PATH_LENGTH)]) {
            assert.equal(pathFormProblem(good), null, good);
        }
    });

    it('names the problem of a path not in normal form, and never cleans it up', () => {
        const cases = [
            ['', PATH_FORM.EMPTY],
            [undefined, PATH_FORM.EMPTY],
            [42, PATH_FORM.EMPTY],
            ['/', PATH_FORM.EMPTY_NAME],
            ['///', PATH_FORM.EMPTY_NAME],
            ['/a', PATH_FORM.EMPTY_NAME],
            ['a/', PATH_FORM.EMPTY_NAME],
            ['a//b', PATH_FORM.EMPTY_NAME],
            [' a', PATH_FORM.SPACE],
            ['a ', PATH_FORM.SPACE],
            ['a/ b', PATH_FORM.SPACE],
            [' a // b ', PATH_FORM.EMPTY_NAME],
            ['a\tb', PATH_FORM.CONTROL],
            ['a\nb', PATH_FORM.CONTROL],
            ['a\u007fb', PATH_FORM.CONTROL],
            ['x'.repeat(MAX_PATH_LENGTH + 1), PATH_FORM.TOO_LONG]
        ];
        for (const [bad, problem] of cases) {
            assert.equal(pathFormProblem(bad), problem, JSON.stringify(bad));
        }
    });
});

describe('path rules among one owner\'s paths', () => {
    it('findPathConflict: unique, and board or folder, never both', () => {
        assert.equal(findPathConflict([]), null);
        assert.equal(findPathConflict(['a/b', 'a/c', 'ab']), null);
        assert.match(findPathConflict(['a', 'a']), /appears twice/);
        assert.match(findPathConflict(['a/b/c', 'a/b']), /lies inside/);
        assert.match(findPathConflict(['a', 'a/b']), /lies inside/);
        // a name that only starts like another is no folder of it
        assert.equal(findPathConflict(['a', 'ab/c']), null);
    });

    it('newBoardProblem', () => {
        const paths = ['teaching/algebra/week1', 'misc'];
        assert.equal(newBoardProblem(paths, 'teaching/algebra/week2'), null);
        assert.equal(newBoardProblem(paths, 'teaching/algebra/week1'), PATH_TAKEN);
        assert.equal(newBoardProblem(paths, 'teaching/algebra'), PATH_TAKEN);
        assert.equal(newBoardProblem(paths, 'misc/inside'), PATH_TAKEN);
        assert.equal(newBoardProblem(paths, ' misc2'), PATH_INVALID);
        assert.equal(newBoardProblem(paths, 'a//b'), PATH_INVALID);
    });

    it('boardMoveProblem', () => {
        const paths = ['a/x', 'a/y', 'b'];
        assert.equal(boardMoveProblem(paths, 'a/x', 'a/x'), null);
        assert.equal(boardMoveProblem(paths, 'a/x', 'c/x'), null);
        assert.equal(boardMoveProblem(paths, 'a/x', 'a/y'), PATH_TAKEN);
        assert.equal(boardMoveProblem(paths, 'a/x', 'b/x'), PATH_TAKEN);
        assert.equal(boardMoveProblem(paths, 'b', 'a'), PATH_TAKEN);
        // the only board of a folder may take the folder's name
        assert.equal(boardMoveProblem(['a/x', 'b'], 'a/x', 'a'), null);
        assert.equal(boardMoveProblem(paths, 'a/x', 'a/'), PATH_INVALID);
    });

    it('folderMove', () => {
        const paths = ['a/x', 'a/y/z', 'b/x', 'ab'];
        assert.deepEqual(folderMove(paths, 'a', 'c'), { moves: [['a/x', 'c/x'], ['a/y/z', 'c/y/z']] });
        assert.deepEqual(folderMove(paths, 'a', 'a'), { moves: [] });
        assert.deepEqual(folderMove(paths, 'a/y', 'q'), { moves: [['a/y/z', 'q/z']] });
        // onto an existing folder: a merge, unless paths collide
        assert.deepEqual(folderMove(['a/x', 'b/y'], 'a', 'b'), { moves: [['a/x', 'b/x']] });
        assert.deepEqual(folderMove(paths, 'a', 'b'), { problem: PATH_TAKEN });
        // onto a board's path, or into it
        assert.deepEqual(folderMove(paths, 'a', 'ab'), { problem: PATH_TAKEN });
        assert.deepEqual(folderMove(paths, 'nothing', 'c'), { problem: NO_SUCH_FOLDER });
        // a board is no folder; 'a' is no folder of 'ab'
        assert.deepEqual(folderMove(paths, 'ab', 'c'), { problem: NO_SUCH_FOLDER });
        assert.deepEqual(folderMove(paths, 'a/', 'c'), { problem: PATH_INVALID });
        assert.deepEqual(folderMove(paths, 'a', ' c'), { problem: PATH_INVALID });
        // the new paths must fit, too
        assert.deepEqual(folderMove(paths, 'a', 'x'.repeat(MAX_PATH_LENGTH - 2)), { problem: PATH_INVALID });
    });
});

describe('snapshots', () => {
    it('recent_snapshots: position 0 and power-of-two distances back from the end', () => {
        assert.deepEqual(shared.recent_snapshots(0), []);
        assert.deepEqual(shared.recent_snapshots(1), [0]);
        assert.deepEqual(shared.recent_snapshots(100), [0, 64, 80, 88, 92, 96, 98, 99]);
        for (let n = 1; n < 300; ++n) {
            const positions = shared.recent_snapshots(n);
            assert.equal(positions[0], 0);
            assert.ok(positions.every((p, i) => i === 0 || positions[i - 1] < p), `sorted for ${n}`);
            assert.ok(positions.every(p => p < n), `inside the history for ${n}`);
            // logarithmically many
            assert.ok(positions.length <= 2 * Math.log2(n + 1) + 2, `few for ${n}`);
        }
    });
});

describe('hashing', () => {
    it('hashAny gives 32 hex digits, the same for equal data', () => {
        const id = uuid();
        assert.match(shared.hashAny(id), /^[0-9a-f]{32}$/);
        assert.equal(shared.hashAny(id), shared.hashAny(id));
        assert.notEqual(shared.hashAny(id), shared.hashAny(uuid()));
        assert.equal(shared.hashAny({ a: [1, 2] }), shared.hashAny({ a: [1, 2] }));
        assert.notEqual(shared.hashAny([1, 2]), shared.hashAny([2, 1]));
    });

    it('hashNext chains: hashAny([previous, action])', () => {
        const anchor = shared.hashAny(uuid());
        const action = draw();
        assert.equal(shared.hashNext(anchor, action), shared.hashAny([anchor, action]));
    });

    it('hashAny and hashNext give the values they always gave', () => {
        // A change of hashAny or serialize changes these values. Then every stored chain
        // is rebuilt on load (see "Hash chain provenance" in server.js), and clients and
        // server must change together: update these values only on purpose.
        const action = {
            type: 'draw',
            uuid: '11111111-1111-4111-8111-111111111111',
            stroke: ['stroke', 'opl', [[1, 2, 0.5, 1700000000000]], '#000000', 2, [1, 0, 0, 1, 0, 0], 1, 0, 0, [], 1, 0, 0]
        };
        assert.equal(shared.hashAny(shared.NULL_UUID), '5ed24ce7680ef473b805fd37314a2cd5');
        assert.equal(shared.hashNext(shared.hashAny(shared.NULL_UUID), action), '63ab5e72353fd88ba78da509b0b1929f');
        assert.equal(shared.hashAny({ s: new Set([1]), m: new Map([['k', 2n]]) }), 'd1722e0ce4afc0f2d311a1f036d4e939');
    });
});

describe('serialization', () => {
    it('serialize and deserialize keep Set, Map and BigInt', () => {
        const value = { s: new Set(['a', 'b']), m: new Map([['k', [1, 2]]]), b: 12345678901234567890n, list: [1, 'x', null] };
        const back = shared.deserialize(shared.serialize(value));
        assert.deepEqual(back, value);
    });
});

describe('uuids', () => {
    it('isUuid accepts version-4 uuids only', () => {
        assert.ok(shared.isUuid(uuid()));
        assert.ok(shared.isUuid(shared.generateUuid()));
        assert.ok(shared.isUuid(shared.NULL_UUID));
        assert.ok(!shared.isUuid('00000000-0000-1000-8000-000000000000'));
        assert.ok(!shared.isUuid('not-a-uuid'));
        assert.ok(!shared.isUuid(uuid() + 'x'));
        assert.ok(!shared.isUuid(undefined));
    });

    it('isUuid accepts strings only', {
        todo: 'open: the regex test turns a list into its text, so ["<uuid>"] passes'
    }, () => {
        assert.ok(!shared.isUuid([uuid()]));
        assert.ok(!shared.isUuid({ toString: () => uuid() }));
    });
});

describe('message validation', () => {
    const board = uuid();
    const page = uuid();
    const proposal = (payload) => ({ type: 'mod-action-proposals', passwd: 'pw', 'board-uuid': board, 'page-uuid': page, payload });
    const invalidProposal = (payload) => shared.is_invalid_MOD_ACTION_PROPOSALS_message(proposal(payload));

    it('accepts every action type in a proposal', () => {
        for (const payload of [draw(), erase(uuid()), group([draw(), erase(uuid())]), undo(uuid()), redo(uuid()), newPage(), deletePage()]) {
            assert.equal(invalidProposal(payload), false, payload.type);
        }
    });

    it('accepts the stroke variants of protocol.md', () => {
        const variants = [
            stroke([[0, 0]], { type: 'fill', path: 'cpl' }),
            stroke([[0, 0]], { path: 'obz' }),
            stroke([[0, 0]], { path: 'cbz' }),
            stroke([[0, 0]], { color: '#abc' }),
            stroke([[0, 0]], { color: 'red' }),
            stroke([[0, 0]], { layer: 7, pen: 3, dash: [1, 2, 3], opacity: 0 })
        ];
        for (const variant of variants) {
            assert.equal(invalidProposal(draw(variant)), false, JSON.stringify(variant));
        }
        const threeNumberPoints = stroke();
        threeNumberPoints[2] = [[1, 2, 0.5]];
        assert.equal(invalidProposal(draw(threeNumberPoints)), false);
    });

    it('rejects malformed strokes', () => {
        const broken = [
            (s) => s.pop(),                      // 12 elements
            (s) => { s[0] = 'blob'; },
            (s) => { s[1] = 'zig'; },
            (s) => { s[2] = []; },
            (s) => { s[2] = [[1, 2]]; },
            (s) => { s[2] = [[1, 2, 3, 4, 5]]; },
            (s) => { s[2] = [[1, NaN, 0.5]]; },
            (s) => { s[2] = [[1, Infinity, 0.5]]; },
            (s) => { s[3] = 'Red'; },
            (s) => { s[3] = '#12345'; },
            (s) => { s[3] = 'x'.repeat(21); },
            (s) => { s[4] = 0; },
            (s) => { s[4] = -1; },
            (s) => { s[5] = [1, 0, 0, 1, 0]; },
            (s) => { s[6] = 1.5; },
            (s) => { s[7] = 3; },
            (s) => { s[8] = 3; },
            (s) => { s[9] = new Array(17).fill(1); },
            (s) => { s[9] = [-1]; },
            (s) => { s[10] = 'x'; },
            (s) => { s[11] = 8; },
            (s) => { s[11] = 1.5; },
            (s) => { s[12] = 4; }
        ];
        for (const breakIt of broken) {
            const s = stroke();
            breakIt(s);
            assert.equal(invalidProposal(draw(s)), true, breakIt.toString());
        }
    });

    it('rejects malformed actions and groups', () => {
        assert.equal(invalidProposal({ type: 'draw', stroke: stroke() }), true, 'no uuid');
        assert.equal(invalidProposal({ type: 'paint', uuid: uuid() }), true, 'unknown type');
        assert.equal(invalidProposal({ type: 'erase', uuid: uuid() }), true, 'erase without target');
        assert.equal(invalidProposal({ type: 'undo', uuid: uuid() }), true, 'undo without target');
        assert.equal(invalidProposal({ type: 'redo', uuid: uuid(), targetActionUuid: 7 }), true, 'redo target not a string');
        assert.equal(invalidProposal({ type: 'group', uuid: uuid(), actions: 'x' }), true, 'group without list');
        assert.equal(invalidProposal(group([undo(uuid())])), true, 'undo in a group');
        assert.equal(invalidProposal(group([newPage()])), true, 'new page in a group');
        let nested = draw();
        for (let depth = 0; depth < 10; ++depth) { nested = group([nested]); }
        assert.equal(invalidProposal(nested), false, '10 levels');
        assert.equal(invalidProposal(group([nested])), true, '11 levels');
    });

    it('rejects proposals without board, page or password', () => {
        assert.equal(shared.is_invalid_MOD_ACTION_PROPOSALS_message({ ...proposal(draw()), passwd: '' }), true);
        assert.equal(shared.is_invalid_MOD_ACTION_PROPOSALS_message({ ...proposal(draw()), 'board-uuid': 'x' }), true);
        assert.equal(shared.is_invalid_MOD_ACTION_PROPOSALS_message({ ...proposal(draw()), 'page-uuid': undefined }), true);
        assert.equal(shared.is_invalid_MOD_ACTION_PROPOSALS_message({ ...proposal(draw()), 'before-hash': 5 }), true);
        assert.equal(shared.is_invalid_MOD_ACTION_PROPOSALS_message(null), true);
    });

    it('checks owner fields: login, credential, requestId, raw path', () => {
        const ok = { type: 'create-board', login: 'ann', passwd: 'secret', path: 'a', requestId: uuid() };
        assert.equal(shared.is_invalid_CREATE_BOARD_message(ok), false);
        assert.equal(shared.is_invalid_CREATE_BOARD_message({ ...ok, login: '' }), true);
        assert.equal(shared.is_invalid_CREATE_BOARD_message({ ...ok, login: 'x'.repeat(65) }), true);
        assert.equal(shared.is_invalid_CREATE_BOARD_message({ ...ok, login: 'x'.repeat(64) }), false);
        assert.equal(shared.is_invalid_CREATE_BOARD_message({ ...ok, passwd: 'x'.repeat(1025) }), true);
        assert.equal(shared.is_invalid_CREATE_BOARD_message({ ...ok, requestId: undefined }), true);
        assert.equal(shared.is_invalid_CREATE_BOARD_message({ ...ok, path: 7 }), true);
        assert.equal(shared.is_invalid_CREATE_BOARD_message({ ...ok, path: 'x'.repeat(4 * MAX_PATH_LENGTH + 1) }), true);
        // a path not in normal form passes validation: the server answers it with invalid path
        assert.equal(shared.is_invalid_CREATE_BOARD_message({ ...ok, path: ' a//b ' }), false);
        assert.equal(shared.is_invalid_CHANGE_CREDENTIAL_message({ type: 'change-credential', login: 'ann', passwd: 'a', 'new-passwd': '', requestId: uuid() }), true);
        assert.equal(shared.is_invalid_SET_PATH_message({ type: 'set-path', login: 'ann', passwd: 'a', path: 'b', requestId: uuid() }), true, 'no board');
        assert.equal(shared.is_invalid_RENAME_PREFIX_message({ type: 'rename-prefix', login: 'ann', passwd: 'a', from: 'a', requestId: uuid() }), true, 'no to');
    });

    it('checks board and page requests', () => {
        assert.equal(shared.is_invalid_REGISTER_BOARD_message({ 'board-uuid': board }), false);
        assert.equal(shared.is_invalid_REGISTER_BOARD_message({ 'board-uuid': board, 'page-uuid': 'x' }), true);
        assert.equal(shared.is_invalid_REGISTER_BOARD_message({ 'board-uuid': board, clientId: 'x' }), true);
        assert.equal(shared.is_invalid_REGISTER_PAGE_message({ 'board-uuid': board, 'page-uuid': page, delta: 1.5 }), true);
        assert.equal(shared.is_invalid_PAGE_INFO_REQUEST_message({ 'board-uuid': board, 'page-uuid': page }), true, 'no requestId');
        assert.equal(shared.is_invalid_FULL_PAGE_REQUEST_message({ 'board-uuid': board, 'page-uuid': page, requestId: uuid(), delta: 0 }), true, 'no register');
        assert.equal(shared.is_invalid_FULL_PAGE_REQUEST_message({ 'board-uuid': board, 'page-uuid': page, requestId: uuid(), delta: 0, register: false }), false);
        assert.equal(shared.is_invalid_REPLAY_REQUEST_message({ 'board-uuid': board, 'page-uuid': page, requestId: uuid(), present: -1, 'present-hash': 'h', register: false }), true);
        assert.equal(shared.is_invalid_BOARD_INFO_REQUEST_message({ 'board-uuid': board, requestId: uuid(), register: 'yes' }), true);
        assert.equal(shared.is_invalid_SHUFFLE_PROPOSAL_message({ 'board-uuid': board, passwd: 'p', requestId: uuid(), before: [], after: [] }), true);
        assert.equal(shared.is_invalid_SHUFFLE_PROPOSAL_message({ 'board-uuid': board, passwd: 'p', requestId: uuid(), before: [page], after: [page] }), false);
    });
});

describe('visual state', () => {
    it('draw shows, erase hides, a second draw of the same uuid fails', () => {
        const state = shared.createEmptyVisualState();
        const a = draw();
        assert.equal(shared.commitEdit(state, a), true);
        assert.equal(shared.commitEdit(state, a), false);
        assert.equal(shared.commitEdit(state, erase(a.uuid)), true);
        assert.equal(state.visible.has(a.uuid), false);
        assert.equal(shared.commitEdit(state, erase(a.uuid)), false);
    });

    it('a group is all or nothing', () => {
        const state = shared.createEmptyVisualState();
        const a = draw();
        shared.commitEdit(state, a);
        const b = draw();
        assert.equal(shared.commitEdit(state, group([b, erase(uuid())])), false);
        assert.deepEqual([...state.visible], [a.uuid]);
        assert.equal(shared.commitEdit(state, group([b, erase(a.uuid)])), true);
        assert.deepEqual([...state.visible], [b.uuid]);
    });

    it('revertEdit undoes commitEdit, groups included', () => {
        const state = shared.createEmptyVisualState();
        const a = draw();
        shared.commitEdit(state, a);
        const moved = group([erase(a.uuid), draw()]);
        shared.commitEdit(state, moved);
        assert.equal(shared.revertEdit(state, moved), true);
        assert.deepEqual([...state.visible], [a.uuid]);
        assert.equal(shared.revertEdit(state, a), true);
        assert.equal(state.visible.size, 0);
    });

    it('compileVisualState replays a history, or gives null for an impossible one', () => {
        const a = draw();
        const b = draw();
        assert.deepEqual([...shared.compileVisualState([a, b, erase(a.uuid)]).visible], [b.uuid]);
        assert.equal(shared.compileVisualState([erase(a.uuid)]), null);
    });
});
