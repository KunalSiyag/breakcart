import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { customerMessage, type ErrorContext } from '../../api/errors';
import { toApiError } from '../../api/http';
import { useElapsed } from '../../lib/hooks';

/** Customer-facing error with the raw code underneath for learners. */
export function ErrorNotice({
  error,
  context = 'browse',
  onRetry,
  retryLabel = 'Try again',
  children,
  compact = false,
}: {
  error: unknown;
  context?: ErrorContext;
  onRetry?: () => void;
  retryLabel?: string;
  children?: ReactNode;
  compact?: boolean;
}) {
  const err = toApiError(error);
  const msg = customerMessage(err, context);
  const icon = msg.tone === 'error' ? '⚠️' : msg.tone === 'warn' ? '⏳' : 'ℹ️';
  return (
    <div className={`notice notice-${msg.tone}${compact ? ' notice-compact' : ''}`} role="alert">
      <span className="notice-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="notice-body">
        <strong className="notice-title">{msg.title}</strong>
        <p className="notice-detail">{msg.detail}</p>
        <p className="notice-code">
          <code>{err.code}</code>
          {err.status > 0 && <span> · HTTP {err.status}</span>}
          {err.retryAfterSec != null && <span> · Retry-After {err.retryAfterSec}s</span>}
          {err.message && err.message !== err.code && <span className="notice-raw"> · {err.message}</span>}
        </p>
        {(onRetry || children) && (
          <div className="notice-actions">
            {onRetry && (
              <button type="button" className="btn btn-sm btn-secondary" onClick={onRetry}>
                {retryLabel}
              </button>
            )}
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

/** Spinner that, after a beat, starts counting seconds — latency you can feel. */
export function Loading({
  label = 'Loading',
  startedAt,
  active = true,
  inline = false,
}: {
  label?: string;
  startedAt: number | null;
  active?: boolean;
  inline?: boolean;
}) {
  const elapsed = useElapsed(startedAt, active);
  const slow = elapsed >= 1.5;
  const verySlow = elapsed >= 8;
  return (
    <div className={`loading${inline ? ' loading-inline' : ''}`} role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>
        {label}
        {slow ? '…' : ''}
        {slow && (
          <span className="loading-elapsed" aria-hidden="true">
            {' '}
            {elapsed.toFixed(0)}s
          </span>
        )}
      </span>
      {verySlow && <span className="loading-hint">This is taking unusually long — the store might be struggling.</span>}
    </div>
  );
}

export function EmptyState({
  emoji,
  title,
  children,
  action,
}: {
  emoji: string;
  title: string;
  children?: ReactNode;
  action?: { to: string; label: string };
}) {
  return (
    <div className="empty">
      <div className="empty-emoji" aria-hidden="true">
        {emoji}
      </div>
      <h2>{title}</h2>
      {children && <p className="muted">{children}</p>}
      {action && (
        <Link to={action.to} className="btn btn-primary">
          {action.label}
        </Link>
      )}
    </div>
  );
}

export function SkeletonGrid({ count = 8 }: { count?: number }) {
  return (
    <div className="grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="tile tile-skeleton">
          <div className="skeleton skeleton-art" />
          <div className="tile-body">
            <div className="skeleton skeleton-line" style={{ width: '40%' }} />
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line" style={{ width: '60%' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  if (pages <= 1) return null;
  const windowed: (number | 'gap')[] = [];
  for (let p = 1; p <= pages; p++) {
    if (p === 1 || p === pages || Math.abs(p - page) <= 1) windowed.push(p);
    else if (windowed[windowed.length - 1] !== 'gap') windowed.push('gap');
  }
  return (
    <nav className="pagination" aria-label="Pages">
      <button type="button" className="btn btn-sm btn-secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ← Prev
      </button>
      {windowed.map((p, i) =>
        p === 'gap' ? (
          <span key={`gap-${i}`} className="pagination-gap" aria-hidden="true">
            …
          </span>
        ) : (
          <button
            key={p}
            type="button"
            className={`btn btn-sm ${p === page ? 'btn-primary' : 'btn-ghost'}`}
            aria-current={p === page ? 'page' : undefined}
            onClick={() => onPage(p)}
          >
            {p}
          </button>
        ),
      )}
      <button
        type="button"
        className="btn btn-sm btn-secondary"
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
      >
        Next →
      </button>
    </nav>
  );
}
