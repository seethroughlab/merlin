/**
 * predev hook: kill any process holding Merlin's TD-bridge port (8001)
 * before vite boots. Cross-platform.
 *
 * Why: on Windows, Ctrl-C / TaskStop on `npm run dev` often leaves the
 * Electron child tree alive. The next launch then hits EADDRINUSE on the
 * WS server and "device busy" on the webcam. This script reaps the
 * orphan so the user's normal `npm run dev` workflow stays clean.
 */

const { execSync } = require('node:child_process');

const PORT = 8001;
const isWin = process.platform === 'win32';

function findPids() {
  try {
    if (isWin) {
      const out = execSync('netstat -ano -p TCP', { encoding: 'utf8' });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        // Match listening sockets on our port. The local-address column ends
        // with `:<port>`, followed by whitespace before the foreign address.
        if (!/LISTENING/.test(line)) continue;
        if (!new RegExp(`:${PORT}\\s`).test(line)) continue;
        const m = line.match(/(\d+)\s*$/);
        if (m) pids.add(m[1]);
      }
      return [...pids];
    } else {
      const out = execSync(`lsof -t -iTCP:${PORT} -sTCP:LISTEN`, { encoding: 'utf8' });
      return out.trim().split('\n').filter(Boolean);
    }
  } catch {
    // Non-zero exit just means "nothing listening" — both netstat-with-no-match
    // and lsof-with-no-match exit non-zero on some platforms.
    return [];
  }
}

function killPid(pid) {
  try {
    execSync(isWin ? `taskkill /F /T /PID ${pid}` : `kill -9 ${pid}`, { stdio: 'ignore' });
  } catch {
    // Already dead or no permission — either way we move on.
  }
}

async function waitFree(timeoutMs = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (findPids().length === 0) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

(async () => {
  const pids = findPids();
  if (!pids.length) {
    console.log(`[predev] port ${PORT} free`);
    return;
  }
  console.log(`[predev] killing stale Merlin pid(s) on port ${PORT}: ${pids.join(', ')}`);
  pids.forEach(killPid);
  const freed = await waitFree();
  // The wait-loop also gives the OS time to release the webcam handle (~1-2s
  // after the holder dies), which is the second resource conflict we care about.
  console.log(`[predev] port ${PORT} ${freed ? 'free' : 'STILL HELD (vite may EADDRINUSE)'}`);
})();
