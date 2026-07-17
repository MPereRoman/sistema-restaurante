const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec, execFile } = require('child_process');

const DEFAULT_PRINTER = process.env.POS_PRINTER || 'POS5890Z';
const CASH_DRAWER_PULSE = Buffer.from([0x1B, 0x70, 0x00, 0x19, 0xFA]);

function execCommand(command, timeout = 25000) {
    return new Promise((resolve, reject) => {
        exec(command, { timeout }, (error, stdout, stderr) => {
            if (error) return reject(new Error(String(stderr || error.message || 'Error al ejecutar impresion')));
            resolve({ stdout, stderr });
        });
    });
}

function execFileWithInput(file, args, input, timeout = 25000) {
    return new Promise((resolve, reject) => {
        const child = execFile(file, args, { timeout }, (error, stdout, stderr) => {
            if (error) return reject(new Error(String(stderr || error.message || 'Error al ejecutar impresion')));
            resolve({ stdout, stderr });
        });
        if (input != null) child.stdin.end(input);
    });
}

function resolvePrinterName(impresoraNombre) {
    return String(impresoraNombre || '').trim() || DEFAULT_PRINTER;
}

function buildThermalPsScript(psPath, psPrinter, anchoMm, fontSize, bold = false) {
    const widthH = Math.round(Number(anchoMm || 58) * 100 / 25.4);
    const pt = Number(fontSize || 1) === 2 ? (bold ? '12' : '10') : (bold ? '10' : '8.5');
    const fontStyle = bold ? ', [System.Drawing.FontStyle]::Bold' : '';
    const lines = [
        'Add-Type -AssemblyName System.Drawing',
        "$script:ls = [System.IO.File]::ReadAllLines('" + psPath + "', [System.Text.Encoding]::UTF8)",
        '$script:i = 0',
        '$pd = New-Object System.Drawing.Printing.PrintDocument',
    ];
    if (psPrinter) lines.push("$pd.PrinterSettings.PrinterName = '" + psPrinter + "'");
    lines.push(
        '$ps = New-Object System.Drawing.Printing.PaperSize("ThermalTicket", ' + widthH + ', 2000)',
        '$pd.DefaultPageSettings.PaperSize = $ps',
        '$pd.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(10, 10, 10, 0)',
        '$script:fn = New-Object System.Drawing.Font("Courier New", ' + pt + fontStyle + ')',
        '$pd.add_PrintPage({',
        '    param($s, $e)',
        '    $y = [float]0',
        '    $lh = [float]$script:fn.GetHeight($e.Graphics)',
        '    while ($script:i -lt $script:ls.Length) {',
        '        $e.Graphics.DrawString($script:ls[$script:i], $script:fn, [System.Drawing.Brushes]::Black, [float]0, $y)',
        '        $y += $lh',
        '        $script:i++',
        '        if (($y + $lh) -gt [float]$e.MarginBounds.Height) { $e.HasMorePages = ($script:i -lt $script:ls.Length); break }',
        '    }',
        '})',
        '$pd.Print()',
        '$script:fn.Dispose()',
        '$pd.Dispose()'
    );
    return lines.join('\r\n');
}

async function printText(texto, options = {}) {
    const {
        printerName,
        copies = 1,
        paperWidthMm = 58,
        fontSize = 1,
        bold = false,
        jobPrefix = 'ticket'
    } = options;
    const tmpFile = path.join(os.tmpdir(), `${jobPrefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    const body = Buffer.from(String(texto || ''), 'utf8');
    fs.writeFileSync(tmpFile, process.platform === 'win32' ? Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), body]) : body);

    try {
        const n = Math.max(1, Number(copies || 1) || 1);
        const printer = resolvePrinterName(printerName);
        for (let c = 0; c < n; c += 1) {
            if (process.platform === 'win32') {
                const psPath = tmpFile.replace(/'/g, "''");
                const psPrinter = printer.replace(/'/g, "''");
                const psScript = buildThermalPsScript(psPath, psPrinter, paperWidthMm, fontSize, bold);
                const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
                await execCommand('powershell -NoProfile -NonInteractive -EncodedCommand ' + encoded);
            } else {
                await new Promise((resolve, reject) => {
                    const args = ['-d', printer, '-o', 'raw', tmpFile];
                    execFile('lp', args, { timeout: 25000 }, (error, stdout, stderr) => {
                        if (error) return reject(new Error(String(stderr || error.message || 'Error al imprimir')));
                        resolve({ stdout, stderr });
                    });
                });
            }
        }
    } finally {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
}

async function openCashDrawer(printerName) {
    const printer = resolvePrinterName(printerName);
    if (process.platform === 'win32') {
        throw new Error('Apertura de cajón por ESC/POS no implementada para Windows');
    }
    await execFileWithInput('lp', ['-d', printer, '-o', 'raw'], CASH_DRAWER_PULSE, 10000);
}

module.exports = {
    DEFAULT_PRINTER,
    buildThermalPsScript,
    execCommand,
    openCashDrawer,
    printText,
    resolvePrinterName
};
