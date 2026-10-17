import { useMemo } from 'react';
import type { IntegrityViolations } from '../../api/types';
import { formatINR, formatInt, relativeTime, toMillis } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { STATUS } from '../palette';
import { useOps } from '../store';
import { Panel, Sparkline, StatusPill } from './ui';

interface ViolationDef {
  key: keyof IntegrityViolations;
  label: string;
  explain: string;
}

const VIOLATIONS: ViolationDef[] = [
  { key: 'oversoldUnits', label: 'Oversold units', explain: 'Units sold beyond physical stock' },
  { key: 'duplicateOrders', label: 'Duplicate orders', explain: 'One checkout created twice' },
  { key: 'duplicateCharges', label: 'Duplicate charges', explain: 'Customer charged twice' },
  { key: 'orphanCharges', label: 'Money taken, no order', explain: 'Charge succeeded, order not paid' },
  { key: 'couponOverRedemptions', label: 'Coupon over-redemptions', explain: 'Coupon used past its cap' },
  { key: 'priceMismatches', label: 'Price mismatches', explain: 'Charged ≠ authoritative price' },
  { key: 'stuckOrders', label: 'Stuck orders', explain: 'Pending payment for too long' },
  { key: 'lostEvents', label: 'Lost events', explain: 'Paid but never shipped' },
  { key: 'phantomHeldUnits', label: 'Phantom held units', explain: 'Stock held by abandoned checkouts' },
  { key: 'paidUncommitted', label: 'Paid, stock not committed', explain: 'Paid order whose stock hold never became a sale' },
  { key: 'negativeStockSkus', label: 'Negative stock', explain: 'SKUs with available < 0' },
];

const MINUTE = 60_000;

function ViolationTile({ def, compact }: { def: ViolationDef; compact: boolean }) {
  const integrity = useOps((s) => s.integrity);
  const history = useOps((s) => s.integrityHistory);
  const trend = useMemo(() => history.map((p) => p.v[def.key]), [history, def.key]);
  const value = integrity?.violations[def.key] ?? null;
  const delta = useMemo(() => {
    if (!history.length) return 0;
    const last = history[history.length - 1]!;
    const base = [...history].reverse().find((p) => last.t - p.t >= MINUTE) ?? history[0]!;
    return last.v[def.key] - base.v[def.key];
  }, [history, def.key]);
  const bad = value != null && value > 0;
  return (
    <div className={`inv${bad ? ' is-violated' : value === 0 ? ' is-holding' : ''}`}>
      <div className="inv-top">
        <span className="inv-label">{def.label}</span>
        {value == null ? null : bad ? (
          <StatusPill level="crit" label="Violated" />
        ) : (
          <span className="inv-ok">
            <span aria-hidden="true">✓</span> holding
          </span>
        )}
      </div>
      <div className="inv-value">
        {value == null ? '—' : formatInt(value)}
        {delta > 0 && <span className="inv-delta">▲ +{formatInt(delta)} / min</span>}
      </div>
      {!compact && <div className="inv-explain">{def.explain}</div>}
      {!compact && trend.length > 1 && (
        <Sparkline values={trend} width={120} height={18} accent={bad ? STATUS.critical : STATUS.good} />
      )}
    </div>
  );
}

export function IntegrityPanel({ compact = false }: { compact?: boolean }) {
  const integrity = useOps((s) => s.integrity);
  const integrityAt = useOps((s) => s.integrityAt);
  const now = useNow(1000);
  const checkedMs = integrity ? (toMillis(integrity.checkedAt) ?? integrityAt) : null;
  const violated = integrity ? VIOLATIONS.filter((d) => integrity.violations[d.key] > 0).length : 0;

  return (
    <Panel
      title="Business invariants"
      subtitle={
        integrity
          ? `${violated ? `${violated} violated` : 'all holding'} · checked ${relativeTime(checkedMs, now)}`
          : 'waiting for the integrity checker…'
      }
      className={`integrity-panel${violated ? ' has-violations' : ''}`}
    >
      <div className={`inv-grid${compact ? ' inv-grid-compact' : ''}`}>
        {VIOLATIONS.map((d) => (
          <ViolationTile key={d.key} def={d} compact={compact} />
        ))}
      </div>

      {integrity && integrity.oversoldSkus.length > 0 && (
        <div className="oversold">
          <h3>Oversold SKUs</h3>
          <table className="ops-table">
            <thead>
              <tr>
                <th scope="col">SKU</th>
                <th scope="col">Product</th>
                <th scope="col" className="num">
                  Stock
                </th>
                <th scope="col" className="num">
                  Claimed
                </th>
                <th scope="col" className="num">
                  Over
                </th>
              </tr>
            </thead>
            <tbody>
              {integrity.oversoldSkus.slice(0, compact ? 5 : 20).map((o) => (
                <tr key={o.sku}>
                  <td>
                    <code>{o.sku}</code>
                  </td>
                  <td>{o.name}</td>
                  <td className="num">{formatInt(o.total)}</td>
                  <td className="num">{formatInt(o.claimed)}</td>
                  <td className="num crit-text">+{formatInt(o.claimed - o.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {integrity && (
        <dl className="totals">
          <div>
            <dt>Orders</dt>
            <dd>{formatInt(integrity.totals.orders)}</dd>
          </div>
          <div>
            <dt>Paid</dt>
            <dd>{formatInt(integrity.totals.paidOrders)}</dd>
          </div>
          <div>
            <dt>GMV</dt>
            <dd>{formatINR(integrity.totals.gmvCents)}</dd>
          </div>
          <div>
            <dt>Units sold</dt>
            <dd>{formatInt(integrity.totals.unitsSold)}</dd>
          </div>
          {!compact && (
            <>
              <div>
                <dt>Charges</dt>
                <dd>{formatInt(integrity.totals.charges)}</dd>
              </div>
              <div>
                <dt>Shipments</dt>
                <dd>{formatInt(integrity.totals.shipments)}</dd>
              </div>
              <div>
                <dt>DLQ</dt>
                <dd>{formatInt(integrity.totals.dlqDepth)}</dd>
              </div>
            </>
          )}
        </dl>
      )}
    </Panel>
  );
}
