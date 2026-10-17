import { closeSync, fsyncSync, ftruncateSync, openSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from './config';

/**
 * The naive logging path (platform.logging = sync_verbose): pretty-print everything and make
 * it "durable" by writing synchronously and fsync-ing every entry — so no log line is ever
 * lost. Every call blocks the event loop until the disk confirms the write.
 * Echoed to stdout as well, which is how most of these start ("just console.log it").
 */
let fd: number | undefined;
let written = 0;
const MAX_BYTES = 100 * 1024 * 1024;
export const SYNC_LOG_PATH = path.join(tmpdir(), `breakcart-${config.service}-requests.log`);

export function syncLog(entry: unknown): void {
  const text = `${JSON.stringify(entry, null, 2)}\n`;
  console.log(text);
  try {
    fd ??= openSync(SYNC_LOG_PATH, 'a');
    writeSync(fd, text);
    fsyncSync(fd);
    written += text.length;
    if (written > MAX_BYTES) {
      // Crude rotation so the lab cannot fill the disk.
      ftruncateSync(fd, 0);
      written = 0;
    }
  } catch {
    if (fd !== undefined) closeSync(fd);
    fd = undefined;
  }
}
