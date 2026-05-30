// Generates a tiny, PII-free single-page PDF with visible text for the
// standalone browser validation. Output: test/sample.pdf
import { writeFileSync } from 'node:fs';

function buildPdf() {
  const objects = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push(
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  );
  const stream =
    'BT /F1 24 Tf 72 700 Td (EmbedPDF PoC sample page) Tj ET\n' +
    'BT /F1 14 Tf 72 660 Td (Render + annotation toolbar validation) Tj ET\n' +
    '1 0 0 1 72 100 cm 0 0 0 RG 2 w 0 0 m 400 0 l S';
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  offsets.forEach((off) => {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

const out = new URL('./sample.pdf', import.meta.url);
writeFileSync(out, buildPdf());
console.log('wrote', out.pathname);
