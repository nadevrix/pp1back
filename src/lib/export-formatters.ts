// Formatters de exportación — CSV / XLSX / PDF.
//
// El endpoint /api/merchant/export delega acá la serialización. Los tres
// formatos comparten el mismo modelo de fila para mantener consistencia.

import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

export interface ExportRow {
    transaction_id: string;
    created_at: string;
    status: string;
    reason: string;
    branch: string;
    asset: string;
    amount_paid: string | number | null;
    fee_amount: string | number | null;
    payout_amount: string | number | null;
    tier_at_time: string | null;
    is_free_tx: boolean | null;
    forward_tx_hash: string | null;
    crypto_tx_hash: string | null;
    wallet_pubkey: string | null;
}

export interface ExportMeta {
    merchantEmail: string;
    from: Date;
    to: Date;
    tier: string;
    generatedAt: Date;
}

const HEADERS: Array<{ key: keyof ExportRow; label: string; width?: number }> = [
    { key: 'transaction_id', label: 'Transaction ID', width: 38 },
    { key: 'created_at', label: 'Fecha', width: 22 },
    { key: 'status', label: 'Estado', width: 14 },
    { key: 'reason', label: 'Motivo', width: 30 },
    { key: 'branch', label: 'Sucursal', width: 22 },
    { key: 'asset', label: 'Asset', width: 8 },
    { key: 'amount_paid', label: 'Cobrado', width: 12 },
    { key: 'fee_amount', label: 'Fee', width: 10 },
    { key: 'payout_amount', label: 'Neto al comercio', width: 16 },
    { key: 'tier_at_time', label: 'Tier', width: 10 },
    { key: 'is_free_tx', label: '¿Gratuita?', width: 10 },
    { key: 'forward_tx_hash', label: 'Tx forward', width: 22 },
    { key: 'crypto_tx_hash', label: 'Tx cliente', width: 22 },
    { key: 'wallet_pubkey', label: 'Wallet pool', width: 22 },
];

// ─── CSV ───────────────────────────────────────────────────────────────────

function csvEscape(value: unknown): string {
    if (value === null || value === undefined) return '';
    const s = String(value);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

export function rowsToCsv(rows: ExportRow[]): string {
    const lines: string[] = [HEADERS.map(h => h.key).join(',')];
    for (const r of rows) {
        lines.push(HEADERS.map(h => csvEscape(r[h.key])).join(','));
    }
    return lines.join('\n') + '\n';
}

// ─── XLSX ──────────────────────────────────────────────────────────────────

export async function rowsToXlsx(rows: ExportRow[], meta: ExportMeta): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Pollar Pay';
    wb.created = meta.generatedAt;

    const sheet = wb.addWorksheet('Movimientos', {
        properties: { defaultColWidth: 14 },
        views: [{ state: 'frozen', ySplit: 1 }],
    });

    sheet.columns = HEADERS.map(h => ({ header: h.label, key: h.key, width: h.width ?? 14 }));

    // Header style
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF005DB4' },
    };
    sheet.getRow(1).alignment = { vertical: 'middle' };

    for (const r of rows) {
        sheet.addRow({
            ...r,
            created_at: r.created_at ? new Date(r.created_at) : null,
            is_free_tx: r.is_free_tx === true ? 'Sí' : r.is_free_tx === false ? 'No' : '',
            amount_paid: r.amount_paid != null ? Number(r.amount_paid) : null,
            fee_amount: r.fee_amount != null ? Number(r.fee_amount) : null,
            payout_amount: r.payout_amount != null ? Number(r.payout_amount) : null,
        });
    }

    // Number formats
    sheet.getColumn('amount_paid').numFmt = '#,##0.0000';
    sheet.getColumn('fee_amount').numFmt = '#,##0.0000';
    sheet.getColumn('payout_amount').numFmt = '#,##0.0000';
    sheet.getColumn('created_at').numFmt = 'yyyy-mm-dd hh:mm:ss';

    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
}

// ─── PDF ───────────────────────────────────────────────────────────────────

// Para PDF mostramos un resumen + las primeras N filas. Tabla completa en PDF
// es poco usable a partir de unos cientos de filas — el merchant que quiera
// el dataset completo usa CSV/XLSX. El PDF apunta a uso de archivo contable.
const PDF_MAX_ROWS = 500;

export function rowsToPdf(rows: ExportRow[], meta: ExportMeta): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        // Header
        doc.fillColor('#005DB4').fontSize(20).text('Pollar Pay — Movimientos', { continued: false });
        doc.moveDown(0.2);
        doc.fillColor('#6b7280').fontSize(9)
            .text(`Comercio: ${meta.merchantEmail}`)
            .text(`Tier: ${meta.tier}`)
            .text(`Rango: ${meta.from.toISOString().slice(0, 10)} → ${meta.to.toISOString().slice(0, 10)}`)
            .text(`Generado: ${meta.generatedAt.toISOString().slice(0, 19).replace('T', ' ')} UTC`)
            .text(`Filas: ${rows.length}${rows.length > PDF_MAX_ROWS ? ` (mostrando primeras ${PDF_MAX_ROWS})` : ''}`);

        doc.moveDown(0.8);

        // Resumen (totales)
        const totals = rows.reduce(
            (acc, r) => {
                acc.amount += Number(r.amount_paid || 0);
                acc.fee += Number(r.fee_amount || 0);
                acc.payout += Number(r.payout_amount || 0);
                acc.byStatus[r.status] = (acc.byStatus[r.status] || 0) + 1;
                return acc;
            },
            { amount: 0, fee: 0, payout: 0, byStatus: {} as Record<string, number> },
        );

        doc.fillColor('#1a1a1a').fontSize(11).text('Resumen', { underline: false });
        doc.fillColor('#1a1a1a').fontSize(10)
            .text(`Total cobrado: ${totals.amount.toFixed(2)} USDC`)
            .text(`Total fee Pollar Pay: ${totals.fee.toFixed(2)} USDC`)
            .text(`Total neto al comercio: ${totals.payout.toFixed(2)} USDC`);

        doc.moveDown(0.4);
        const statusLine = Object.entries(totals.byStatus)
            .map(([k, v]) => `${k}: ${v}`)
            .join('  ·  ');
        if (statusLine) doc.fillColor('#6b7280').fontSize(9).text(statusLine);

        doc.moveDown(0.8);

        // Tabla — sólo las columnas más útiles en print (sino no entra)
        const cols: Array<{ key: keyof ExportRow; label: string; width: number }> = [
            { key: 'created_at', label: 'Fecha', width: 110 },
            { key: 'status', label: 'Estado', width: 60 },
            { key: 'reason', label: 'Motivo', width: 180 },
            { key: 'branch', label: 'Sucursal', width: 110 },
            { key: 'amount_paid', label: 'Cobrado', width: 60 },
            { key: 'fee_amount', label: 'Fee', width: 50 },
            { key: 'payout_amount', label: 'Neto', width: 60 },
            { key: 'forward_tx_hash', label: 'Tx hash', width: 100 },
        ];

        const startX = doc.x;
        let y = doc.y;
        const rowH = 16;
        const pageBottom = doc.page.height - doc.page.margins.bottom - rowH;

        const drawHeader = () => {
            let x = startX;
            doc.fillColor('#ffffff').rect(startX, y, cols.reduce((s, c) => s + c.width, 0), rowH).fill('#005DB4');
            doc.fillColor('#ffffff').fontSize(9);
            for (const c of cols) {
                doc.text(c.label, x + 4, y + 4, { width: c.width - 8, lineBreak: false });
                x += c.width;
            }
            y += rowH;
        };

        drawHeader();

        const shown = rows.slice(0, PDF_MAX_ROWS);
        doc.fontSize(8).fillColor('#1a1a1a');

        for (let i = 0; i < shown.length; i++) {
            if (y > pageBottom) {
                doc.addPage({ size: 'A4', layout: 'landscape', margin: 36 });
                y = doc.y;
                drawHeader();
                doc.fontSize(8).fillColor('#1a1a1a');
            }

            // Zebra
            if (i % 2 === 0) {
                doc.fillColor('#f0f7ff').rect(startX, y, cols.reduce((s, c) => s + c.width, 0), rowH).fill();
                doc.fillColor('#1a1a1a');
            }

            let x = startX;
            const r = shown[i];
            for (const c of cols) {
                let value: string;
                if (c.key === 'created_at') {
                    value = r.created_at ? new Date(r.created_at).toISOString().slice(0, 19).replace('T', ' ') : '';
                } else if (c.key === 'amount_paid' || c.key === 'fee_amount' || c.key === 'payout_amount') {
                    value = r[c.key] != null ? Number(r[c.key]).toFixed(4) : '';
                } else if (c.key === 'forward_tx_hash') {
                    value = r.forward_tx_hash ? r.forward_tx_hash.slice(0, 12) + '…' : '';
                } else {
                    value = String(r[c.key] ?? '');
                }
                doc.text(value, x + 4, y + 4, { width: c.width - 8, lineBreak: false, ellipsis: true });
                x += c.width;
            }
            y += rowH;
        }

        // Footer
        doc.fontSize(7).fillColor('#9ca3af')
            .text(
                'Reporte generado por Pollar Pay. Cada transacción es verificable on-chain en Stellar Expert con el hash provisto.',
                doc.page.margins.left,
                doc.page.height - doc.page.margins.bottom + 4,
                { align: 'center', width: doc.page.width - doc.page.margins.left - doc.page.margins.right },
            );

        doc.end();
    });
}
