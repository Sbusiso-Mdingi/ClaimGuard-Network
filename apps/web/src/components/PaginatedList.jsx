import React, { useMemo } from "react";

export default function PaginatedList({ items, page, pageSize, onPageChange, renderItem, ariaLabel = 'List' }) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const current = useMemo(() => {
    const start = (page - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, page, pageSize]);

  function setPage(p) {
    const next = Math.max(1, Math.min(totalPages, p));
    if (next !== page && onPageChange) onPageChange(next);
  }

  return (
    <div aria-label={ariaLabel}>
      <div>{current.map((it, i) => renderItem(it, i))}</div>

      <div className="pagination" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <button aria-label="First page" onClick={() => setPage(1)} disabled={page === 1}>{'<<'}</button>
        <button aria-label="Previous page" onClick={() => setPage(page - 1)} disabled={page === 1}>{'<'}</button>
        <span>Page {page} / {totalPages}</span>
        <button aria-label="Next page" onClick={() => setPage(page + 1)} disabled={page === totalPages}>{'>'}</button>
        <button aria-label="Last page" onClick={() => setPage(totalPages)} disabled={page === totalPages}>{'>>'}</button>
      </div>
    </div>
  );
}
