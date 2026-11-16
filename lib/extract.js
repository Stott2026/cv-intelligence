// Turns an uploaded CV (PDF or Word .docx) into plain text.
// Nothing is saved to disk: the file stays in memory for this request only.
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

// Fewer readable characters than this means the PDF is almost certainly a scan (an image of text).
const MIN_TEXT_CHARS = 200;

export class CvError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function kindOf(file) {
  const name = (file.originalname || '').toLowerCase();
  if (name.endsWith('.pdf') || file.mimetype === 'application/pdf') return 'pdf';
  if (name.endsWith('.docx') || file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (name.endsWith('.doc')) return 'doc';
  return 'other';
}

export async function extractCvText(file) {
  const kind = kindOf(file);
  if (kind === 'doc') {
    throw new CvError('This is an old Word .doc file. Open it in Word and save it as .docx or PDF, then upload it again.');
  }
  if (kind === 'other') {
    throw new CvError('Please upload a PDF or a Word (.docx) CV.');
  }

  let text = '';
  try {
    if (kind === 'docx') {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      text = result.value;
    } else {
      const pdf = await getDocumentProxy(new Uint8Array(file.buffer));
      const result = await extractText(pdf, { mergePages: true });
      text = result.text;
    }
  } catch {
    throw new CvError('We could not open this file. It may be damaged or password-protected. Try saving it again as PDF or .docx.');
  }

  text = tidy(text);
  if (text.replace(/\s/g, '').length < MIN_TEXT_CHARS) {
    if (kind === 'pdf') {
      throw new CvError('This PDF looks like a scanned image, so there is no text to read. Ask the candidate for a Word version, or a PDF saved from Word or Google Docs, and upload that instead.', 422);
    }
    throw new CvError('This document has almost no text in it. Check it is the right file.', 422);
  }
  return text;
}

function tidy(text) {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
