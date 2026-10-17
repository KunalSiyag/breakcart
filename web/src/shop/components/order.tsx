import type { Order, OrderStatus } from '../../api/types';

const STATUS_COPY: Record<OrderStatus, { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'muted'; icon: string }> = {
  CREATED: { label: 'Created', tone: 'info', icon: '•' },
  REJECTED: { label: 'Rejected', tone: 'bad', icon: '✕' },
  AWAITING_PAYMENT: { label: 'Awaiting payment', tone: 'info', icon: '💳' },
  PAYMENT_IN_PROGRESS: { label: 'Payment in progress', tone: 'warn', icon: '⏳' },
  PAYMENT_PENDING: { label: 'Confirming payment', tone: 'warn', icon: '⏳' },
  PAID: { label: 'Paid', tone: 'ok', icon: '✓' },
  PAYMENT_FAILED: { label: 'Payment failed', tone: 'bad', icon: '✕' },
  EXPIRED: { label: 'Expired', tone: 'muted', icon: '⌛' },
};

export function OrderStatusPill({ status }: { status: OrderStatus | string }) {
  const meta = STATUS_COPY[status as OrderStatus] ?? { label: status, tone: 'muted' as const, icon: '•' };
  return (
    <span className={`status-pill status-${meta.tone}`}>
      <span aria-hidden="true">{meta.icon}</span> {meta.label}
    </span>
  );
}

/** PAYMENT_FAILED is terminal (stock released); declined payments return to AWAITING_PAYMENT. */
export function canPay(o: Order): boolean {
  return o.status === 'AWAITING_PAYMENT' || o.status === 'CREATED';
}
