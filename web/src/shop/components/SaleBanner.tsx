import { formatClock } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { saleClock, useSale } from '../SaleContext';

function ClockDigits({ seconds, label }: { seconds: number; label: string }) {
  const text = formatClock(seconds);
  return (
    <span className="clock" role="timer" aria-label={`${label} ${text}`}>
      {text.split(':').map((part, i) => (
        <span key={i} className="clock-seg" aria-hidden="true">
          {i > 0 && <span className="clock-colon">:</span>}
          <span className="clock-box">{part}</span>
        </span>
      ))}
    </span>
  );
}

export function SaleBanner() {
  const { sale, offsetMs, error, lastOkAt } = useSale();
  const now = useNow(500);
  const clock = saleClock(sale, offsetMs, now);
  const skew = Math.abs(offsetMs) >= 1000 ? `Server clock is ${(offsetMs / 1000).toFixed(1)}s off this device` : 'Synced with server clock';
  const stale = error != null && (lastOkAt == null || now - lastOkAt > 15_000);

  if (!sale && !error && lastOkAt != null) return null; // no sale configured
  if (!sale) {
    return (
      <div className="sale-banner sale-banner-muted" role="region" aria-label="Sale status">
        <div className="container sale-inner">
          <span>{error ? '⚡ Sale info is unavailable right now — reconnecting…' : '⚡ Loading today’s sale…'}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`sale-banner sale-${clock.phase}`} role="region" aria-label="Sale status" title={skew}>
      <div className="container sale-inner">
        <div className="sale-main">
          <span className="sale-name">
            {clock.phase === 'live' ? '🔥' : '⚡'} {sale.name}
          </span>
          {clock.phase === 'upcoming' && (
            <span className="sale-when">
              starts in <ClockDigits seconds={clock.remainingSec} label="Sale starts in" />
            </span>
          )}
          {clock.phase === 'live' && (
            <span className="sale-when">
              <span className="live-dot" aria-hidden="true" /> LIVE NOW · ends in{' '}
              <ClockDigits seconds={clock.remainingSec} label="Sale ends in" />
            </span>
          )}
          {clock.phase === 'ended' && <span className="sale-when">has ended — thanks for shopping!</span>}
          {stale && <span className="sale-stale">(reconnecting…)</span>}
        </div>
        {clock.phase !== 'ended' && (
          <div className="sale-coupon">
            Extra savings with code <code>BIGSALE500</code>
          </div>
        )}
      </div>
    </div>
  );
}
