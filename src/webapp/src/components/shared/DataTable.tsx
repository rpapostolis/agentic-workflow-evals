import { ReactElement, JSXElementConstructor } from "react";
import { useSelectableClick } from "@/hooks/useSelectableClick";

export interface TableColumn<T = any> {
  key: string;
  header: string;
  width?: string;
  minWidth?: string;
  maxWidth?: string;
  render: (
    item: T
  ) => string | number | ReactElement<any, string | JSXElementConstructor<any>>;
}

export interface DataTableProps<T = any> {
  columns: TableColumn<T>[];
  data: T[];
  onRowClick?: (item: T) => void;
  emptyState?: ReactElement<any, string | JSXElementConstructor<any>>;
  minColumnWidth?: string;
}

export function DataTable<T = any>({
  columns,
  data,
  onRowClick,
  emptyState,
}: DataTableProps<T>) {
  const { createClickHandler } = useSelectableClick();

  const handleRowClick = onRowClick
    ? createClickHandler((item: T) => onRowClick(item))
    : undefined;

  if (data.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  // Build CSS grid template from column widths
  const gridTemplate = columns
    .map((col) => col.width || "1fr")
    .join(" ");

  return (
    <div className="w-full">
      {/* Header row */}
      <div
        className="grid items-center text-sm text-muted-foreground"
        style={{ gridTemplateColumns: gridTemplate, padding: "16px 8px" }}
      >
        {columns.map((column) => (
          <span
            key={column.key}
            className="truncate"
          >
            {column.header}
          </span>
        ))}
      </div>

      {/* Data rows */}
      {data.map((item, index) => (
        <div
          key={(item as any).id || index}
          className="grid items-center text-sm border-b border-border last:border-b-0 hover:bg-secondary/50 transition-colors"
          style={{
            gridTemplateColumns: gridTemplate,
            padding: "16px 8px",
            cursor: onRowClick ? "pointer" : "default",
            userSelect: "text",
          }}
          onClick={
            handleRowClick
              ? (event) => handleRowClick(item, event)
              : undefined
          }
        >
          {columns.map((column) => (
            <div
              key={column.key}
              className="overflow-hidden text-ellipsis whitespace-nowrap min-w-0"
            >
              {column.render(item)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
