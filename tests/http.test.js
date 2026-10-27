'use strict';
// What the server answers over HTTP: the client page with shared.js embedded, the
// PWA files, and nothing else.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { ROOT, httpGet, startServer, removeDir } = require('./harness');

describe('HTTP', () => {
    let server;

    before(async () => { server = await startServer(); });
    after(async () => {
        await server.stop();
        removeDir(server.dir);
    });

    it('serves the client for / with a known query key, shared.js embedded', async () => {
        for (const query of ['?board=x', '?board=x&passwd=y', '?login=a', '?credential=b', '?board=']) {
            const answer = await httpGet(`${server.url}/${query}`);
            assert.equal(answer.status, 200, query);
            assert.match(answer.headers['content-type'], /text\/html/);
            const html = answer.body.toString();
            assert.ok(html.includes('// Begin shared.js content'), query);
            assert.ok(!html.includes('<script src="shared.js"></script>'), query);
            assert.ok(html.includes(`const WHITEBOARD_WS_URL = "${server.wsUrl}";`), query);
        }
    });

    it('serves the PWA files with their types', async () => {
        const files = {
            '/manifest.json': ['manifest.json', 'application/json'],
            '/sw.js': ['sw.js', 'application/javascript'],
            '/icon-192.png': ['icon-192.png', 'image/png'],
            '/icon-512.png': ['icon-512.png', 'image/png'],
            '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
            '/favicon.ico': ['favicon.ico', 'image/vnd.microsoft.icon'],
            '/robots.txt': ['robots.txt', 'text/plain']
        };
        for (const [url, [file, type]] of Object.entries(files)) {
            const answer = await httpGet(server.url + url);
            assert.equal(answer.status, 200, url);
            assert.equal(answer.headers['content-type'], type, url);
            assert.deepEqual(answer.body, fs.readFileSync(path.join(ROOT, file)), url);
        }
    });

    it('serves nothing else', async () => {
        const refused = [
            ['/', 404], ['/?other=1', 404], ['/?board=x&other=1', 404],
            ['/index.html', 404], ['/shared.js', 404], ['/server.js', 404], ['/users.js', 404],
            ['/conf/users.json', 404], ['/data/', 404], ['/logs/debug.log', 404], ['/package.json', 404],
            ['/../server.js', 404], ['/%2e%2e/server.js', 404],
            ['/.env', 403], ['/.git/config', 403], ['/a/.hidden', 403]
        ];
        for (const [url, status] of refused) {
            const answer = await httpGet(server.url + url);
            assert.equal(answer.status, status, url);
            assert.ok(!answer.body.toString().includes('Begin shared.js content'), url);
        }
    });

    it('takes WebSocket connections on /ws only', async () => {
        const good = new WebSocket(server.wsUrl);
        await new Promise((resolve, reject) => { good.once('open', resolve); good.once('error', reject); });
        good.close();
        const bad = new WebSocket(`ws://127.0.0.1:${server.port}/other`);
        await assert.rejects(new Promise((resolve, reject) => { bad.once('open', resolve); bad.once('error', reject); }));
    });
});
