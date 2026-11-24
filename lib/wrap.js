// "Candidate's own CV": the candidate's own PDF, page by page and untouched, laid onto Stott and May
// framed pages (lib/format.js buildOwnFrame) after the cover sheet. The pages are copied as they are
// (text, fonts and images unchanged), only scaled to fit the white card. In memory only; nothing stored.
import { PDFDocument } from 'pdf-lib';
import { buildOwnFrame, OWN_CARD } from './format.js';
import { CvError } from './extract.js';

const MAX_PAGES = 20;

export async function wrapOwnCv({ pdf, fields }) {
  let original;
  try {
    original = await PDFDocument.load(pdf, { updateMetadata: false });
  } catch (err) {
    if (/encrypt/i.test(String(err?.message))) throw new CvError('This PDF is password-protected, so it cannot be placed in a Stott and May frame. Ask for an unlocked copy.', 422);
    throw new CvError('This PDF could not be opened. Try saving it again as a PDF.', 422);
  }
  const count = original.getPageCount();
  if (count < 1) throw new CvError('This PDF has no pages.', 422);
  if (count > MAX_PAGES) throw new CvError(`This PDF has ${count} pages; the most this can frame is ${MAX_PAGES}.`, 422);

  const frame = await PDFDocument.load(await buildOwnFrame({ fields, pageCount: count }));
  const embedded = await frame.embedPages(original.getPages());
  const box = {
    x: OWN_CARD.x + OWN_CARD.pad, y: OWN_CARD.y + OWN_CARD.pad,
    w: OWN_CARD.w - 2 * OWN_CARD.pad, h: OWN_CARD.h - 2 * OWN_CARD.pad,
  };
  embedded.forEach((page, i) => {
    const target = frame.getPage(i + 1); // page 0 is the cover
    const scale = Math.min(box.w / page.width, box.h / page.height);
    const w = page.width * scale, h = page.height * scale;
    // pdf-lib measures from the bottom-left corner; the frame from the top-left.
    target.drawPage(page, { x: box.x + (box.w - w) / 2, y: target.getHeight() - box.y - h - (box.h - h) / 2, width: w, height: h });
  });
  return Buffer.from(await frame.save());
}
