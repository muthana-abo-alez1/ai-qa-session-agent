import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';

function appendWorksheet(workbook, name, records) {
  let sheet = workbook.getWorksheet(name);
  const alreadyExists = Boolean(sheet);
  if (!sheet) {
    sheet = workbook.addWorksheet(name);
    const columns = Object.keys(records[0] ?? {}).map((key) => ({ header: key, key, width: Math.min(Math.max(key.length + 4, 18), 48) }));
    sheet.columns = columns;
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  } else {
    const expectedHeaders = Object.keys(records[0] ?? {});
    expectedHeaders.forEach((header, index) => {
      const column = index + 1;
      const currentHeader = sheet.getRow(1).getCell(column).value;
      if (currentHeader !== header && !sheet.getRow(1).values.includes(header)) {
        sheet.spliceColumns(column, 0, []);
        sheet.getRow(1).getCell(column).value = header;
        sheet.getRow(1).getCell(column).font = { bold: true };
      }
    });
  }
  records.forEach((record) => sheet.addRow(alreadyExists ? Object.values(record) : record));
}

export async function writeReport({ session, events, issues, pages, pageMap }) {
  const reportsDirectory = path.resolve('reports');
  await fs.mkdir(reportsDirectory, { recursive: true });

  const filename = 'qa-session-history.xlsx';
  const absolutePath = path.join(reportsDirectory, filename);
  const workbook = new ExcelJS.Workbook();
  try {
    await fs.access(absolutePath);
    await workbook.xlsx.readFile(absolutePath);
  } catch {
    // The first session creates the workbook and its three worksheets.
  }
  appendWorksheet(workbook, 'Sessions', [session]);
  appendWorksheet(workbook, 'Events', events);
  appendWorksheet(workbook, 'Issues', issues);
  appendWorksheet(workbook, 'Pages', pages);
  appendWorksheet(workbook, 'Page Map', pageMap);
  await workbook.xlsx.writeFile(absolutePath);
  return filename;
}
