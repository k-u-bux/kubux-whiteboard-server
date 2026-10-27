'use strict';
// users.js: reading the user file, hashing and verifying credentials.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadUsers, hashPassword, hashPasswordAsync, verifyPassword } = require(path.join(__dirname, '..', 'users.js'));
const { uuid, removeDir } = require('./harness');

describe('hashing and verifying credentials', () => {
    it('a hash is salt:key in hex, salted afresh each time', async () => {
        const hash = hashPassword('secret');
        assert.match(hash, /^[0-9a-f]{64}:[0-9a-f]{128}$/);
        assert.notEqual(hashPassword('secret'), hash);
        assert.match(await hashPasswordAsync('secret'), /^[0-9a-f]{64}:[0-9a-f]{128}$/);
    });

    it('verifyPassword accepts the credential and nothing else, spaces included', async () => {
        const reports = [];
        const report = message => reports.push(message);
        for (const hash of [hashPassword(' with spaces '), await hashPasswordAsync(' with spaces ')]) {
            assert.equal(await verifyPassword(' with spaces ', hash, report), true);
            assert.equal(await verifyPassword('with spaces', hash, report), false);
            assert.equal(await verifyPassword(' with spaces', hash, report), false);
            assert.equal(await verifyPassword('', hash, report), false);
        }
        assert.deepEqual(reports, []);
    });

    it('a malformed stored hash does not match, and is reported', async () => {
        const reports = [];
        const report = message => reports.push(message);
        assert.equal(await verifyPassword('x', 'no-colon', report), false);
        assert.equal(await verifyPassword('x', 'abcd:ef', report), false);
        assert.equal(reports.length, 2);
        assert.match(reports[0], /salt:hash/);
        assert.match(reports[1], /wrong length/);
    });
});

describe('loadUsers', () => {
    let dir;
    const file = () => path.join(dir, 'users.json');
    const write = (text) => fs.writeFileSync(file(), text);
    const entry = (login, id = uuid()) => ({ id, login, hash: hashPassword('x') });

    before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubux-users-test-')); });
    after(() => removeDir(dir));

    it('gives the entries as they are in the file, extra fields included', () => {
        const entries = [entry('ann'), { ...entry('bob'), note: 'kept' }];
        write(JSON.stringify(entries));
        assert.deepEqual(loadUsers(file()), entries);
        write('[]');
        assert.deepEqual(loadUsers(file()), []);
    });

    it('says when the file is missing, and points to the old passwd.json', () => {
        const missing = path.join(dir, 'missing', 'users.json');
        assert.throws(() => loadUsers(missing), /No user file .*create it with passwd_hash/);
        fs.mkdirSync(path.join(dir, 'missing'));
        fs.writeFileSync(path.join(dir, 'missing', 'passwd.json'), '{}');
        assert.throws(() => loadUsers(missing), /passwd\.json is no longer read/);
    });

    it('says when the file cannot be read', { skip: process.getuid && process.getuid() === 0 ? 'root reads anything' : false }, () => {
        write('[]');
        fs.chmodSync(file(), 0o000);
        try {
            assert.throws(() => loadUsers(file()), /Cannot read user file/);
        } finally {
            fs.chmodSync(file(), 0o600);
        }
    });

    it('refuses an invalid file', () => {
        const cases = [
            ['not json', /Invalid user file/],
            ['{}', /expected a list/],
            [JSON.stringify([{ login: 'ann', hash: 'a:b' }]), /malformed entry/],
            [JSON.stringify([{ id: 'x', login: 'ann', hash: 'a:b' }]), /malformed entry/],
            [JSON.stringify([{ id: uuid(), login: '', hash: 'a:b' }]), /malformed entry/],
            [JSON.stringify([{ id: uuid(), login: 'ann', hash: 'nocolon' }]), /malformed entry/],
            [JSON.stringify([null]), /malformed entry/],
            [JSON.stringify([entry('ann'), entry('ann')]), /login ann appears twice/]
        ];
        for (const [text, problem] of cases) {
            write(text);
            assert.throws(() => loadUsers(file()), problem, text);
        }
        const id = uuid();
        write(JSON.stringify([entry('ann', id), entry('bob', id)]));
        assert.throws(() => loadUsers(file()), /appears twice/);
    });
});
