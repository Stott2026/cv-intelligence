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

// Letter-spaced text (a run of 8 or more one- or two-character pieces, such as
// "C A N D I D AT E R E S U M E" or "S T O T T A N D M AY - 0 1") is the page furniture of a CV that has
// already been through a formatter (headers, eyebrows, footers). It is never real CV content, so it is removed.
const SPACED_RE = /(?:^|(?<=\s))(?:[^\s]{1,2} ){7,}[^\s]{1,2}(?=\s|$)/gm;
export function stripPageFurniture(text) {
  return String(text || '').split('\n')
    .map((line) => line.replace(SPACED_RE, ' ').replace(/[ \t]{2,}/g, ' ').trim())
    .filter((line, i, all) => line || (i > 0 && all[i - 1]))
    .join('\n');
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
  } catch (err) {
    // Log only the error type and message (never CV content) so failures can be diagnosed.
    console.error(JSON.stringify({ event: 'cv_extract_failed', kind, error: String(err?.name || 'Error'), message: String(err?.message || '').slice(0, 200) }));
    throw new CvError('We could not open this file. It may be damaged or password-protected. Try saving it again as PDF or .docx.');
  }

  text = stripPageFurniture(tidy(text));
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
