import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFileSync } from "node:fs";
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync("fixture/main.pdf")) }).promise;
const pageNo = Number(process.argv[2] || 1);
const page = await doc.getPage(pageNo);
const tc = await page.getTextContent();
tc.items.forEach((it, i) => {
  if (it.type) { console.log(i, "MARK", it.type); return; }
  const t = it.transform;
  console.log(`${String(i).padStart(3)} x=${t[4].toFixed(2)} y=${t[5].toFixed(2)} w=${it.width.toFixed(2)} h=${it.height.toFixed(2)} eol=${it.hasEOL?1:0} f=${it.fontName} "${it.str}"`);
});
