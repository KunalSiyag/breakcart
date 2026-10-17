import { useEffect, useRef } from 'react';
import { shopApi } from '../../api/shop';
import { rememberProducts } from '../../lib/art';
import { formatInt } from '../../lib/format';
import { useAsync, useDocumentTitle, useNow } from '../../lib/hooks';
import { ErrorNotice, Loading, SkeletonGrid } from '../components/feedback';
import { ProductGrid, ProductRow, ProductTile } from '../components/product';
import { saleClock, useSale, type SalePhase } from '../SaleContext';

/** Refetch the deals the moment the countdown flips to live — exactly what every real
 *  shopper's browser does at 00:00:00 (and why sale starts are thundering herds). */
function PhaseFlipWatcher({ onLive }: { onLive: () => void }) {
  const { sale, offsetMs } = useSale();
  const now = useNow(1000);
  const phase = saleClock(sale, offsetMs, now).phase;
  const prev = useRef<SalePhase>(phase);
  useEffect(() => {
    if (prev.current === 'upcoming' && phase === 'live') onLive();
    prev.current = phase;
  }, [phase, onLive]);
  return null;
}

export default function HomePage() {
  useDocumentTitle('BreakCart — Sale day deals');
  const home = useAsync(async (signal) => {
    const { data } = await shopApi.home(signal);
    const deals = Array.isArray(data?.deals) ? data.deals : [];
    const recommendations = Array.isArray(data?.recommendations) ? data.recommendations : [];
    rememberProducts([...deals, ...recommendations]);
    return { deals, recommendations, degraded: Array.isArray(data?.degraded) ? data.degraded : [] };
  }, []);
  const watcher = <PhaseFlipWatcher onLive={home.reload} />;

  if (!home.data) {
    return (
      <div className="container page">
        {watcher}
        {home.error ? (
          <ErrorNotice error={home.error} onRetry={home.reload} />
        ) : (
          <>
            <Loading label="Loading today’s deals" startedAt={home.startedAt} />
            <SkeletonGrid count={8} />
          </>
        )}
      </div>
    );
  }

  const { deals, recommendations, degraded } = home.data;
  const soldOut = deals.filter((d) => d.stock && d.stock.available <= 0).length;
  const recsDegraded = degraded.some((d) => /rec/i.test(d));

  return (
    <div className="container page">
      {watcher}
      <h1 className="sr-only">BreakCart — today’s deals</h1>
      {home.error && <ErrorNotice error={home.error} onRetry={home.reload} compact />}
      {home.loading && <Loading label="Refreshing deals" startedAt={home.startedAt} inline />}
      {degraded.length > 0 && (
        <p className="degraded-note" role="status">
          <span aria-hidden="true">🩹</span> Some sections are degraded right now ({degraded.join(', ')}). You can keep
          shopping — checkout is unaffected.
        </p>
      )}

      <section aria-labelledby="deals-h" className="deals">
        <div className="section-head">
          <h2 id="deals-h">⚡ Flash deals</h2>
          <span className="muted">
            {formatInt(deals.length)} deals · {soldOut > 0 ? `${soldOut} sold out · ` : ''}limited stock, first come first
            served
          </span>
        </div>
        {deals.length === 0 ? (
          <p className="muted">No deals right now. Check back when the sale starts!</p>
        ) : (
          <ProductGrid>
            {deals.map((d) => (
              <ProductTile key={d.id} p={d} stock={d.stock} />
            ))}
          </ProductGrid>
        )}
      </section>

      <ProductRow
        title="Recommended for you"
        products={recommendations}
        note={
          recsDegraded ? (
            <span className="muted">Personalised picks are unavailable — showing popular items.</span>
          ) : recommendations.length === 0 ? (
            <span className="muted">No recommendations right now.</span>
          ) : undefined
        }
      />
    </div>
  );
}
