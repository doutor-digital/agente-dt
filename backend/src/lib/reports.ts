// ============================================================================
// reports.ts — helpers de CSV e PDF para os endpoints de relatórios.
//
// LÓGICA DE ENGENHARIA
// --------------------
// - CSV: monta string em UTF-8 com escape simples (",", aspas, quebras). Não
//   uso lib porque a complexidade é mínima e adicionar papaparse no backend
//   é overhead injustificado.
// - PDF: usa pdfkit (canvas-style: cursor + draw). Mantemos um layout simples
//   tabular pra ficar legível em A4 paisagem.
//
// Ambos retornam Buffer ou stream — controller decide o Content-Type/Disposition.
// ============================================================================

import PDFDocument from 'pdfkit';

/** Uma linha de relatório é um dict de strings/numbers pra cada coluna. */
export type ReportRow = Record<string, string | number | null | undefined>;

export interface ReportSpec {
  /** Título do relatório (header do PDF, "filename" do download). */
  title: string;
  /** Subtítulo curto (período, unit etc.). Aparece logo abaixo do título no PDF. */
  subtitle?: string;
  /** Ordem das colunas + label legível pra header. */
  columns: Array<{ key: string; label: string; width?: number }>;
  rows: ReportRow[];
  /** Footer opcional (gerado em / por / total). */
  footer?: string;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Escapa um valor pra CSV. Aspas duplas + escape de aspas internas + quebra. */
function escapeCsv(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r;]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildCsv(spec: Pick<ReportSpec, 'columns' | 'rows'>): string {
  const header = spec.columns.map((c) => escapeCsv(c.label)).join(',');
  const body = spec.rows
    .map((r) => spec.columns.map((c) => escapeCsv(r[c.key])).join(','))
    .join('\n');
  // BOM pra Excel reconhecer UTF-8 sem precisar trocar locale.
  return `﻿${header}\n${body}\n`;
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/**
 * Monta um PDF com layout tabular e devolve um Buffer (em vez de stream)
 * — caller cuida do Content-Disposition. Layout: A4 paisagem, cabeçalho,
 * subtítulo, tabela com headers cinza, linhas alternadas, paginação.
 */
export async function buildPdf(spec: ReportSpec): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margin: 36, // ~12mm
    info: { Title: spec.title, Creator: 'Agente DT' },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // Header
  doc
    .fillColor('#111')
    .font('Helvetica-Bold')
    .fontSize(16)
    .text(spec.title, { align: 'left' });
  if (spec.subtitle) {
    doc
      .moveDown(0.2)
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#666')
      .text(spec.subtitle);
  }
  doc.moveDown(0.6);

  // Tabela
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const totalWeight = spec.columns.reduce((sum, c) => sum + (c.width ?? 1), 0);
  const colWidths = spec.columns.map((c) => Math.floor(((c.width ?? 1) / totalWeight) * pageWidth));

  const rowHeight = 18;
  const headerY = doc.y;

  function drawHeader() {
    let x = doc.page.margins.left;
    doc
      .rect(x, doc.y, pageWidth, rowHeight)
      .fillColor('#f4f4f5')
      .fill();
    doc.fillColor('#27272a').font('Helvetica-Bold').fontSize(9);
    spec.columns.forEach((c, i) => {
      doc.text(c.label, x + 6, doc.y - rowHeight + 5, {
        width: colWidths[i] - 12,
        ellipsis: true,
      });
      x += colWidths[i];
    });
    doc.font('Helvetica').fontSize(9).fillColor('#111');
  }

  doc.y = headerY;
  drawHeader();
  doc.y = headerY + rowHeight;

  let rowIdx = 0;
  for (const row of spec.rows) {
    // Pagebreak se passar do limite (deixa 30pt pra footer).
    if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom - 30) {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: 36 });
      drawHeader();
      doc.y += rowHeight;
    }
    // Zebra
    if (rowIdx % 2 === 1) {
      doc
        .rect(doc.page.margins.left, doc.y, pageWidth, rowHeight)
        .fillColor('#fafafa')
        .fill();
      doc.fillColor('#111');
    }
    let x = doc.page.margins.left;
    spec.columns.forEach((c, i) => {
      const value = row[c.key];
      const text = value === null || value === undefined ? '—' : String(value);
      doc.text(text, x + 6, doc.y + 4, {
        width: colWidths[i] - 12,
        ellipsis: true,
        lineBreak: false,
      });
      x += colWidths[i];
    });
    doc.y += rowHeight;
    rowIdx++;
  }

  if (spec.rows.length === 0) {
    doc.moveDown(0.5).fillColor('#666').fontSize(10).text('Sem dados no período selecionado.');
  }

  if (spec.footer) {
    doc.moveDown(1).fillColor('#999').fontSize(8).text(spec.footer, { align: 'right' });
  }

  doc.end();
  return done;
}

// ---------------------------------------------------------------------------
// Helpers de filename pra download.
// ---------------------------------------------------------------------------

export function reportFilename(slug: string, format: 'csv' | 'pdf', range?: { from?: Date | null; to?: Date | null }): string {
  const today = new Date().toISOString().slice(0, 10);
  let suffix = today;
  if (range?.from && range?.to) {
    const f = range.from.toISOString().slice(0, 10);
    const t = range.to.toISOString().slice(0, 10);
    suffix = `${f}_a_${t}`;
  }
  return `${slug}_${suffix}.${format}`;
}
