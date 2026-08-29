import { spawn } from 'node:child_process';

// Only accept the ChildProcess created by this bot, never a user-supplied PID.
export function killProcessTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true, stdio: 'ignore',
    });
    killer.once('error', () => child.kill());
    killer.once('exit', (code) => { if (code !== 0 && child.exitCode === null) child.kill(); });
  } else child.kill('SIGKILL');
}

export function bindProcessCancellation(child, signal, kill = killProcessTree) {
  const abort = () => kill(child);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const cleanup = () => signal?.removeEventListener('abort', abort);
  child.once('close', cleanup);
  return cleanup;
}
