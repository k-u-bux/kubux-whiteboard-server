'use strict';
// The admin tools: passwd_hash (a user entry for conf/users.json) and assign_board
// (an owner and a path for a board from before ownership).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ROOT, uuid, startServer, makeInstanceDir, removeDir } = require('./harness');
const { verifyPassword } = require(path.join(ROOT, 'users.js'));
const { serialize, deserialize, isUuid } = require(path.join(ROOT, 'shared.js'));

function run(tool, args, cwd = ROOT) {
    const result = spawnSync(path.join(ROOT, tool), args, { cwd, encoding: 'utf8' });
    return { code: result.status, out: result.stdout, err: result.stderr };
}

describe('passwd_hash', () => {
    // the entry is the JSON object at the start of the output
    const entryOf = (out) => JSON.parse(out.slice(0, out.indexOf('}') + 1));

    it('prints an entry with a fresh id, the login and a hash of the credential', async () => {
        const first = run('passwd_hash', ['ann', ' a credential ']);
        assert.equal(first.code, 0, first.err);
        const entry = entryOf(first.out);
        assert.deepEqual(Object.keys(entry), ['id', 'login', 'hash']);
        assert.ok(isUuid(entry.id));
        assert.equal(entry.login, 'ann');
        assert.equal(await verifyPassword(' a credential ', entry.hash, assert.fail), true);
        assert.equal(await verifyPassword('a credential', entry.hash, assert.fail), false);
        assert.notEqual(entryOf(run('passwd_hash', ['ann', ' a credential ']).out).id, entry.id);
    });

    it('takes login and credential as data, never as code', async () => {
        const marker = path.join(ROOT, 'tests', `pwned-${uuid()}`);
        const nasty = `$(touch ${marker})'"\`;\\n`;
        const result = run('passwd_hash', [`ann"'`, nasty]);
        assert.equal(result.code, 0, result.err);
        const entry = entryOf(result.out);
        assert.equal(entry.login, `ann"'`);
        assert.equal(await verifyPassword(nasty, entry.hash, assert.fail), true);
        assert.equal(fs.existsSync(marker), false);
    });

    it('wants exactly two arguments', () => {
        for (const args of [[], ['ann'], ['ann', 'x', 'y']]) {
            const result = run('passwd_hash', args);
            assert.equal(result.code, 1);
            assert.match(result.out, /Usage/);
        }
    });
});

describe('assign_board', () => {
    // An instance with ann and bob, a board from before ownership and one of ann's
    function instance() {
        const { dir, entries } = makeInstanceDir([{ login: 'ann', credential: 'ann' }, { login: 'bob', credential: 'bob' }]);
        const legacy = uuid();
        const owned = uuid();
        fs.writeFileSync(path.join(dir, 'data', `${legacy}.board`), serialize({ passwd: 'legacypasswd', pageOrder: [uuid()] }));
        fs.writeFileSync(path.join(dir, 'data', `${owned}.board`), serialize({ passwd: 'ownedpasswd1', pageOrder: [uuid()], owner: entries[0].id, path: 'taken/board', createdAt: 1 }));
        return { dir, entries, legacy, owned };
    }
    const board = (dir, id) => deserialize(fs.readFileSync(path.join(dir, 'data', `${id}.board`), 'utf8'));

    it('gives a board an owner, a path and a creation time; the server lists it', async () => {
        const { dir, entries, legacy } = instance();
        try {
            const result = run('assign_board', [legacy, 'ann', 'old/lecture 1'], dir);
            assert.equal(result.code, 0, result.err);
            assert.match(result.out, /now belongs to ann as old\/lecture 1/);
            const file = board(dir, legacy);
            assert.equal(file.owner, entries[0].id);
            assert.equal(file.path, 'old/lecture 1');
            assert.equal(typeof file.createdAt, 'number');
            assert.equal(file.passwd, 'legacypasswd');
            assert.deepEqual(fs.readdirSync(path.join(dir, 'data')).filter(name => name.endsWith('.tmp')), []);

            const server = await startServer({ dir });
            try {
                const client = await server.connect();
                const list = await client.listBoards('ann', 'ann');
                assert.deepEqual(list.boards.map(entry => entry.path), ['old/lecture 1', 'taken/board']);
            } finally {
                await server.stop();
            }
        } finally {
            removeDir(dir);
        }
    });

    it('refuses bad arguments, owned boards and the path rules, and changes nothing', () => {
        const { dir, legacy, owned } = instance();
        try {
            const before = fs.readFileSync(path.join(dir, 'data', `${legacy}.board`), 'utf8');
            const cases = [
                [[], /usage/],
                [[legacy, 'ann'], /usage/],
                [['not-a-uuid', 'ann', 'x'], /not a board id/],
                [[uuid(), 'ann', 'x'], /no board file/],
                [[legacy, 'nobody', 'x'], /no user with login nobody/],
                [[owned, 'bob', 'x'], /already has an owner/],
                [[legacy, 'ann', 'a//b'], /not a valid path \(empty name\)/],
                [[legacy, 'ann', ' a'], /not a valid path/],
                [[legacy, 'ann', 'taken/board'], /is taken for ann/],
                [[legacy, 'ann', 'taken'], /is taken for ann/],
                [[legacy, 'ann', 'taken/board/inside'], /is taken for ann/]
            ];
            for (const [args, problem] of cases) {
                const result = run('assign_board', args, dir);
                assert.equal(result.code, 1, args.join(' '));
                assert.match(result.err, problem, args.join(' '));
            }
            assert.equal(fs.readFileSync(path.join(dir, 'data', `${legacy}.board`), 'utf8'), before);
            // another owner's paths are no obstacle
            assert.equal(run('assign_board', [legacy, 'bob', 'taken/board'], dir).code, 0);
        } finally {
            removeDir(dir);
        }
    });

    it('refuses to run without a valid user file', () => {
        const { dir, legacy } = instance();
        try {
            fs.writeFileSync(path.join(dir, 'conf', 'users.json'), 'not json');
            const result = run('assign_board', [legacy, 'ann', 'x'], dir);
            assert.equal(result.code, 1);
            assert.match(result.err, /Invalid user file/);
        } finally {
            removeDir(dir);
        }
    });
});
