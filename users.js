'use strict';
// Users and their credentials, for the server and the admin tools (assign_board,
// passwd_hash): reading the user file, and hashing and verifying credentials.
//
// The user file conf/users.json: a list of { id, login, hash }. The id never changes and
// is what boards record as their owner; the login is what people type; the hash is the
// scrypt hash of the credential.
//
// The file is the only truth about users and their credentials. Whoever needs a user
// (the server for every credential check, assign_board) reads the file through
// loadUsers, every time, and keeps no copy: a user the admin adds, changes or removes
// counts at once. The file is small and cached by the system; a read costs far less
// than the scrypt check that follows it in the server.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isUuid } = require(path.join(__dirname, 'shared.js'));

// Credential hashes are scrypt (memory-hard, resistant to rainbow tables and to
// hardware-accelerated brute force), stored as salt:hash, both hex-encoded. Parameters:
// N (CPU/memory cost) 2^14, r (block size) 8, p (parallelization) 1; a 64-byte key and
// a 32-byte random salt. Changing them makes every stored hash invalid.
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 32;

const formatHash = (salt, key) => `${salt.toString('hex')}:${key.toString('hex')}`;

// The hash of a credential, for the user file (passwd_hash, the server's dummy hash)
function hashPassword(password) {
    const salt = crypto.randomBytes(SALT_LENGTH);
    return formatHash(salt, crypto.scryptSync(password, salt, KEY_LENGTH, SCRYPT_OPTIONS));
}

// hashPassword in Node's worker pool, so that a credential change does not block the
// server's event loop
function hashPasswordAsync(password) {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(SALT_LENGTH);
        crypto.scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS, (error, key) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(formatHash(salt, key));
        });
    });
}

// Whether the credential matches the stored hash. scrypt runs in Node's worker pool,
// so the ~50 ms it takes do not block the event loop. The user file is edited by the
// admin and treated like input: a malformed hash is passed to report and simply does
// not match.
function verifyPassword(password, storedHash, report) {
    return new Promise((resolve) => {
        const [saltHex, hashHex] = storedHash.split(':');
        if (!saltHex || !hashHex) {
            report('Invalid hash format - expected salt:hash format');
            resolve(false);
            return;
        }
        const salt = Buffer.from(saltHex, 'hex');
        const storedKey = Buffer.from(hashHex, 'hex');
        crypto.scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS, (error, computedKey) => {
            if (error) {
                report(`Error verifying password: ${error.message}`);
                resolve(false);
                return;
            }
            // timingSafeEqual throws on a length mismatch, i.e. on a malformed stored hash
            if (storedKey.length !== computedKey.length) {
                report('Invalid hash format - stored hash has the wrong length');
                resolve(false);
                return;
            }
            // timing-safe comparison against timing attacks
            resolve(crypto.timingSafeEqual(storedKey, computedKey));
        });
    });
}

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

module.exports = { loadUsers, hashPassword, hashPasswordAsync, verifyPassword };
