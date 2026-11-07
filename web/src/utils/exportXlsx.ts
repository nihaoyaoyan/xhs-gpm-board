import dayjs from 'dayjs';
import * as XLSX from 'xlsx';

export interface ExportColumn {
  title: string;
  dataIndex: string;
  formatter?: (value: unknown, row: Record<string, unknown>) => string | number;
}

export function exportXlsx(
  filename: string,
  columns: ExportColumn[],
  rows: Record<string, unknown>[],
): void {
  if (!rows.length) return;
  const data = rows.map((row) =>
    Object.fromEntries(
      columns.map((column) => {
        const raw = row[column.dataIndex];
        const value = column.formatter ? column.formatter(raw, row) : raw;
        return [column.title, value ?? ''];
      }),
    ),
  );
  const sheet = XLSX.utils.json_to_sheet(data);
  sheet['!cols'] = columns.map((column) => ({ wch: Math.max(12, column.title.length * 2 + 4) }));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, '数据');
  XLSX.writeFile(book, `${filename}_${dayjs().format('YYYYMMDD_HHmm')}.xlsx`);
}
