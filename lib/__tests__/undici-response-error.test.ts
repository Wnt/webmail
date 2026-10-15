// @vitest-environment node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

// GHSA-xjj6-f33q-929c: isolate the dependency's process-level error so it
// cannot kill Vitest. The only socket is an ephemeral loopback test server.
// fetchPublicUrl uses this installed undici fetch implementation; its URL/DNS
// checks do not constrain a permitted calendar server's response headers.
it('a rejected over-encoded response must not crash the server process', async () => {
  const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:http';
    import { Agent, fetch } from 'undici';
    const dispatcher = new Agent();
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        'content-encoding': 'gzip, gzip, gzip, gzip, gzip, gzip',
        'content-length': '10',
        connection: 'close',
      });
      res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await fetch('http://127.0.0.1:' + server.address().port + '/calendar.ics', { dispatcher });
    } catch {
      // The route already catches fetch failures; that must be sufficient.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    await dispatcher.close();
    await new Promise(resolve => server.close(resolve));
    console.log('survived');
  `], { timeout: 5000 }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  );
  expect(child, child.stderr).toMatchObject({ code: 0, stdout: 'survived\n' });
});
