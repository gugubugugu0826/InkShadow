import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { importDocxDocuments, importPdfDocuments, preflightImport } from "../src/index.js";

describe("DOCX import boundary", () => {
  it("extracts real OOXML text without fetching external relationships", async () => {
    const bytes = await createDocx({
      paragraphs: ["第一章 雾港", "门开了。", "第二章 回声", "钟声仍在。"],
      externalHyperlink: true,
    });

    const documents = await importDocxDocuments("长篇.docx", bytes);

    expect(documents).toHaveLength(2);
    expect(documents.map(({ title }) => title)).toEqual(["第一章 雾港", "第二章 回声"]);
    expect(documents[0]?.markdown).toContain("门开了");
    expect(documents[0]?.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(documents[0]?.issues).toContainEqual(
      expect.objectContaining({
        code: "MARKDOWN_EXTERNAL_REFERENCE_REMOVED",
        severity: "warning",
      }),
    );
    expect(JSON.stringify(documents)).not.toContain("attacker.example");
  });

  it("rejects macro/embedded entries, expansion bombs, and extension disguises", async () => {
    const macro = await createDocx({
      paragraphs: ["第一章", "正文"],
      extraEntries: [["word/vbaProject.bin", new Uint8Array([1, 2, 3])]],
    });
    await expect(importDocxDocuments("macro.docx", macro)).rejects.toMatchObject({
      code: "IMPORT_ARCHIVE_ACTIVE_CONTENT",
    });

    const bomb = await createDocx({
      paragraphs: ["第一章", "正文"],
      extraEntries: [["word/media/repetition.txt", "x".repeat(2 * 1024 * 1024)]],
    });
    await expect(importDocxDocuments("bomb.docx", bomb)).rejects.toMatchObject({
      code: "IMPORT_ARCHIVE_LIMIT_EXCEEDED",
    });

    await expect(
      importDocxDocuments("fake.docx", new TextEncoder().encode("not a zip")),
    ).rejects.toMatchObject({ code: "IMPORT_MAGIC_MISMATCH" });
  });
});

describe("PDF import boundary", () => {
  it("extracts text from a real local PDF without rendering or network access", async () => {
    const bytes = createPdf({ text: ["Chapter 1 Opening", "Local text only."] });

    const documents = await importPdfDocuments("novel.pdf", bytes);

    expect(documents).toHaveLength(1);
    expect(documents[0]?.title).toBe("Chapter 1 Opening");
    expect(documents[0]?.markdown).toContain("Local text only");
    expect(documents[0]?.sourceFormat).toBe("pdf");
    expect(documents[0]?.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects scanned/no-text, encrypted, active, and disguised PDFs", async () => {
    await expect(importPdfDocuments("scan.pdf", createPdf({ text: [] }))).rejects.toMatchObject({
      code: "PDF_TEXT_UNAVAILABLE",
    });
    await expect(
      importPdfDocuments("encrypted.pdf", createPdf({ encrypted: true, text: ["Secret"] })),
    ).rejects.toMatchObject({
      code: "PDF_ENCRYPTED_UNSUPPORTED",
    });
    await expect(
      importPdfDocuments("active.pdf", createPdf({ javaScript: true, text: ["Text"] })),
    ).rejects.toMatchObject({
      code: "PDF_ACTIVE_CONTENT_FORBIDDEN",
    });
    await expect(
      importPdfDocuments("fake.pdf", new TextEncoder().encode("not a pdf")),
    ).rejects.toMatchObject({ code: "IMPORT_MAGIC_MISMATCH" });
  });
});

describe("byte-oriented preflight", () => {
  it("accepts all five document formats and reports exact source bytes", async () => {
    const files = [
      { name: "one.md", bytes: new TextEncoder().encode("# One\nText") },
      {
        name: "two.docx",
        bytes: await createDocx({ paragraphs: ["第二章", "DOCX text"] }),
      },
      {
        name: "three.html",
        bytes: new TextEncoder().encode("<article><p>HTML text</p></article>"),
      },
      { name: "four.pdf", bytes: createPdf({ text: ["Chapter 4", "PDF text"] }) },
      { name: "five.txt", bytes: new TextEncoder().encode("TXT text") },
    ] as const;

    const report = await preflightImport(files);

    expect(report.status).toBe("ready");
    expect(report.format).toBe("mixed");
    expect(report.summary.fileCount).toBe(5);
    expect(report.summary.chapterCount).toBe(5);
    expect(report.summary.totalBytes).toBe(
      files.reduce((total, { bytes }) => total + bytes.byteLength, 0),
    );
  });

  it("blocks lossy text decoding instead of silently inserting replacement characters", async () => {
    const report = await preflightImport([
      {
        name: "broken.txt",
        bytes: new Uint8Array([0xc3, 0x28]),
      },
    ]);

    expect(report.status).toBe("blocked");
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "IMPORT_ENCODING_UNCERTAIN" }),
    );
  });
});

async function createDocx({
  externalHyperlink = false,
  extraEntries = [],
  paragraphs,
}: {
  readonly externalHyperlink?: boolean;
  readonly extraEntries?: readonly (readonly [string, string | Uint8Array])[];
  readonly paragraphs: readonly string[];
}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
      "</Types>",
    ].join(""),
  );
  zip.file(
    "_rels/.rels",
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
      "</Relationships>",
    ].join(""),
  );
  zip.file(
    "word/document.xml",
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
      ...paragraphs.map((paragraph) => `<w:p><w:r><w:t>${escapeXml(paragraph)}</w:t></w:r></w:p>`),
      "</w:body></w:document>",
    ].join(""),
  );
  if (externalHyperlink) {
    zip.file(
      "word/_rels/document.xml.rels",
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://attacker.example/" TargetMode="External"/>',
        "</Relationships>",
      ].join(""),
    );
  }
  for (const [name, value] of extraEntries) {
    zip.file(name, value);
  }
  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function createPdf({
  encrypted = false,
  javaScript = false,
  text,
}: {
  readonly encrypted?: boolean;
  readonly javaScript?: boolean;
  readonly text: readonly string[];
}): Uint8Array {
  const content = text.length === 0 ? "" : createPdfTextStream(text);
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R${javaScript ? " /OpenAction 6 0 R" : ""} >>`,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`,
    ...(javaScript ? ["<< /S /JavaScript /JS (app.alert\\(1\\)) >>"] : []),
    ...(encrypted
      ? [
          "<< /Filter /Standard /V 1 /R 2 /Length 40 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>",
        ]
      : []),
  ];
  const parts = ["%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n"];
  const offsets = [0];
  let byteLength = encodedLength(parts[0] ?? "");
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(byteLength);
    const object = `${String(index + 1)} 0 obj\n${objects[index] ?? ""}\nendobj\n`;
    parts.push(object);
    byteLength += encodedLength(object);
  }
  const xrefOffset = byteLength;
  const xref = [
    `xref\n0 ${String(objects.length + 1)}\n`,
    "0000000000 65535 f \n",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
  ].join("");
  const encryptObjectNumber = encrypted ? objects.length : undefined;
  const trailer = [
    "trailer\n",
    `<< /Size ${String(objects.length + 1)} /Root 1 0 R`,
    encryptObjectNumber === undefined
      ? ""
      : ` /Encrypt ${String(encryptObjectNumber)} 0 R /ID [<00112233445566778899aabbccddeeff><00112233445566778899aabbccddeeff>]`,
    " >>\n",
    `startxref\n${String(xrefOffset)}\n%%EOF\n`,
  ].join("");
  return new TextEncoder().encode(`${parts.join("")}${xref}${trailer}`);
}

function createPdfTextStream(lines: readonly string[]): string {
  const commands = ["BT", "/F1 12 Tf", "72 720 Td"];
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0) {
      commands.push("0 -24 Td");
    }
    commands.push(`(${escapePdfString(lines[index] ?? "")}) Tj`);
  }
  commands.push("ET");
  return commands.join("\n");
}

function escapePdfString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function encodedLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
