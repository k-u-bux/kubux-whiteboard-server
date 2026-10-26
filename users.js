'use strict';
// The user file conf/users.json: a list of { id, login, hash }. The id never changes and
// is what boards record as their owner; the login is what people type; the hash is the
// scrypt hash of the credential.
//
// The file is the only truth about users and their credentials. Whoever needs a user
// (the server for every credential check, assign_board) reads the file through
// loadUsers, every time, and keeps no copy: a user the admin adds, changes or removes
// counts at once. The file is small and cached by the system; a read costs far less
// than the scrypt check that follows it in the server.

const fs = require('fs');
const path = require('path');
const { isUuid } = require(path.join(__dirname, 'shared.js'));

// The entries as they are in the file (extra fields included), or an error that says
// whether the file is missing, unreadable (permissions, mounts) or invalid. The file is
// edited by the admin and treated like input.
function loadUsers(filePath) {
    let text;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        // a missing file and one we may not read look alike otherwise
        if (error.code !== 'ENOENT') {
            throw new Error(`Cannot read user file ${filePath}: ${error.message}`);
        }
        const oldFilePath = path.join(path.dirname(filePath), 'passwd.json');
        const hint = fs.existsSync(oldFilePath)
            ? `${oldFilePath} is no longer read; create ${filePath} with passwd_hash (see readme.md)`
            : 'create it with passwd_hash (see readme.md)';
        throw new Error(`No user file ${filePath}: ${hint}`);
    }
    try {
        const entries = JSON.parse(text);
        checkUsers(entries);
        return entries;
    } catch (error) {
        throw new Error(`Invalid user file ${filePath}: ${error.message}`);
    }
}

function checkUsers(entries) {
    if (!Array.isArray(entries)) {
        throw new Error('expected a list of { "id", "login", "hash" } entries');
    }
    const ids = new Set();
    const logins = new Set();
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object'
            || !isUuid(entry.id)
            || typeof entry.login !== 'string' || entry.login.length === 0
            || typeof entry.hash !== 'string' || !entry.hash.includes(':')) {
            throw new Error(`malformed entry ${JSON.stringify(entry)}`);
        }
        if (ids.has(entry.id)) { throw new Error(`id ${entry.id} appears twice`); }
        if (logins.has(entry.login)) { throw new Error(`login ${entry.login} appears twice`); }
        ids.add(entry.id);
        logins.add(entry.login);
    }
}

module.exports = { loadUsers };
