// Word to PDF for "Candidate's own CV", with LibreOffice (installed on Railway by railpack.json).
// LibreOffice can only read a file from disk, so the Word CV is written to a private temporary folder,
// converted, read back into memory and the folder is deleted straight away, even if the conversion fails.
// Nothing is kept and the CV's content is never logged.
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CvError } from './extract.js';

const TIMEOUT_MS = 90_000;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS }, (err) => (err ? reject(err) : resolve()));
  });
}

const FAILED = 'This Word CV could not be turned into a PDF. Save it as a PDF in Word and upload that instead.';

export async function wordToPdf(buffer) {
  // A real .docx is a zip file (starts "PK"); otherwise LibreOffice would turn any junk into a page of text.
  if (!buffer || buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new CvError(FAILED, 422);
  const dir = await mkdtemp(join(tmpdir(), 'cvi-'));
  try {
    const input = join(dir, 'cv.docx');
    await writeFile(input, buffer, { mode: 0o600 });
    // Its own LibreOffice profile each time, so two consultants converting at once don't clash.
    const profile = pathToFileURL(join(dir, 'profile')).href;
    try {
      await run('soffice', [`-env:UserInstallation=${profile}`, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', dir, input]);
    } catch (err) {
      console.error(JSON.stringify({ event: 'word_to_pdf_failed', reason: err.code === 'ENOENT' ? 'soffice not installed' : (err.killed ? 'timeout' : 'error') }));
      throw new CvError(FAILED, 422);
    }
    try {
      return await readFile(join(dir, 'cv.pdf'));
    } catch {
      throw new CvError(FAILED, 422);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
